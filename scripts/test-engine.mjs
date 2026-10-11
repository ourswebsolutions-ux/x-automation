#!/usr/bin/env node
/**
 * Runs the engine's Python tests with the bundled runtime (not a system Python),
 * and — when a Chrome/Chromium is installed — starts a dedicated, throwaway Chrome
 * with remote debugging so the CDP and publishing tests attach to a real browser.
 *
 * The browser picks its own free port (--remote-debugging-port=0) and reports it in
 * <profile>/DevToolsActivePort, so no other process can hold "our" port. The tests
 * start only after /json/version answers; if Chrome can't be brought up, the run
 * fails with Chrome's own output instead of handing the tests a dead endpoint.
 * The publishing tests only ever talk to the local X stand-in (engine/tests/x_fixture.py);
 * the engine refuses non-loopback test targets.
 *
 *   CHROME_PATH=/path/to/chrome   use this browser instead of the usual locations
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const platformDir = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'
const python = join(root, 'engine-runtime', platformDir, 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
if (!existsSync(python)) {
  console.error(`Bundled runtime not found at ${python}. Run: npm run engine:prepare`)
  process.exit(1)
}

const READY_TIMEOUT_MS = 60_000
const LAUNCH_ATTEMPTS = 3
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const candidates = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean)
const browserPath = candidates.find((b) => existsSync(b))
if (process.env.CHROME_PATH && browserPath !== process.env.CHROME_PATH) {
  console.error(`CHROME_PATH is set but ${process.env.CHROME_PATH} does not exist.`)
  process.exit(1)
}

/** One launch: resolves with the endpoint once Chrome answers, or with the reason it didn't. */
async function launchOnce(path) {
  const profileDir = mkdtempSync(join(tmpdir(), 'axora-cdp-'))
  const child = spawn(
    path,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-extensions',
      '--password-store=basic',
      '--use-mock-keychain',
      'about:blank'
    ],
    // Own process group (POSIX), so the whole browser tree — renderers, GPU, zygote — can be stopped together.
    { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' }
  )
  let stderr = ''
  child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-4000)))
  let exit = null
  child.once('exit', (code, signal) => (exit = { code, signal }))
  child.once('error', (error) => (exit = { code: null, signal: null, error: error.message }))

  const portFile = join(profileDir, 'DevToolsActivePort')
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline && !exit) {
    if (existsSync(portFile)) {
      const port = Number(readFileSync(portFile, 'utf8').split(/\r?\n/)[0])
      if (Number.isInteger(port) && port > 0) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })
          if (res.ok) return { child, profileDir, endpoint: `http://127.0.0.1:${port}`, version: (await res.json()).Browser, get stderr() { return stderr } }
        } catch {
          // not answering yet
        }
      }
    }
    await sleep(250)
  }
  const reason = exit
    ? `Chrome exited before its debugging endpoint was ready (${exit.error ?? `code ${exit.code}, signal ${exit.signal}`})`
    : `Chrome's debugging endpoint did not answer within ${READY_TIMEOUT_MS / 1000} s`
  await stopBrowser({ child, profileDir })
  return { reason, stderr }
}

/** Stops the browser and every process it started, then removes its throwaway profile. */
async function stopBrowser(browser) {
  if (!browser) return
  const { child, profileDir } = browser
  if (child?.pid) {
    const exited = child.exitCode === null && child.signalCode === null ? new Promise((r) => child.once('exit', r)) : Promise.resolve()
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else {
      try {
        process.kill(-child.pid, 'SIGKILL') // the whole process group
      } catch {
        // already gone
      }
    }
    await Promise.race([exited, sleep(5000)])
  }
  if (!profileDir) return
  // Helper processes can still be writing for a moment after the kill; retry until the folder is gone.
  for (let attempt = 0; attempt < 25 && existsSync(profileDir); attempt++) {
    try {
      rmSync(profileDir, { recursive: true, force: true })
    } catch {
      // busy; try again
    }
    if (existsSync(profileDir)) await sleep(200)
  }
  if (existsSync(profileDir)) console.warn(`Could not remove the temporary browser profile ${profileDir}.`)
}

let browser = null
const cleanupAndExit = async (code) => {
  await stopBrowser(browser)
  process.exit(code)
}
process.on('SIGINT', () => void cleanupAndExit(130))
process.on('SIGTERM', () => void cleanupAndExit(143))

const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', SystemRoot: process.env.SystemRoot ?? '' }
if (browserPath) {
  for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS && !browser; attempt++) {
    const started = Date.now()
    const result = await launchOnce(browserPath)
    if (result.endpoint) {
      browser = result
      console.log(`Real browser for CDP tests: ${browserPath} — ${result.version} at ${result.endpoint} (ready in ${Date.now() - started} ms)`)
    } else {
      console.warn(`Browser launch ${attempt}/${LAUNCH_ATTEMPTS} failed: ${result.reason}`)
      if (result.stderr.trim()) console.warn(result.stderr.trim().split('\n').slice(-12).map((l) => `  chrome: ${l}`).join('\n'))
    }
  }
  if (!browser) {
    console.error(`\nCould not start ${browserPath} with remote debugging after ${LAUNCH_ATTEMPTS} attempts, so the CDP and publishing tests cannot run. Not skipping them — failing instead.`)
    process.exit(1)
  }
  env.AXORA_TEST_CDP_ENDPOINT = browser.endpoint
} else {
  console.log('No Chrome/Chromium found — the CDP integration and publishing tests will be skipped (not faked). Set CHROME_PATH to run them.')
}

const result = spawnSync(python, ['-I', '-X', 'utf8', '-m', 'unittest', 'discover', '-s', 'tests', '-t', 'tests', '-v'], { cwd: join(root, 'engine'), env, stdio: 'inherit' })
if (browser && (browser.child.exitCode !== null || browser.child.signalCode !== null)) {
  console.error(`\nNote: the test browser exited during the tests (code ${browser.child.exitCode}, signal ${browser.child.signalCode}).`)
  if (browser.stderr?.trim()) console.error(browser.stderr.trim())
}
await cleanupAndExit(result.status ?? 1)
