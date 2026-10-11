#!/usr/bin/env node
/**
 * Runs the engine's Python tests with the bundled runtime (not a system Python),
 * and — when a Chrome/Chromium is installed — starts it with remote debugging so
 * the CDP integration test attaches to a real browser.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const platformDir = process.platform === 'win32' ? 'win' : 'linux'
const python = join(root, 'engine-runtime', platformDir, 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
if (!existsSync(python)) {
  console.error(`Bundled runtime not found at ${python}. Run: npm run engine:prepare`)
  process.exit(1)
}

const browsers = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', 'C:/Program Files/Google/Chrome/Application/chrome.exe']
const browserPath = browsers.find((b) => existsSync(b))
const port = 9300 + Math.floor(Math.random() * 500)
let browser = null
let profileDir = null
const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', SystemRoot: process.env.SystemRoot ?? '' }
if (browserPath) {
  profileDir = mkdtempSync(join(tmpdir(), 'axora-cdp-'))
  browser = spawn(browserPath, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) break
    } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  env.AXORA_TEST_CDP_ENDPOINT = `http://127.0.0.1:${port}`
  console.log(`Real browser for CDP tests: ${browserPath} (port ${port})`)
} else {
  console.log('No Chrome/Chromium found — the CDP integration test will be skipped (not faked).')
}

const result = spawnSync(python, ['-I', '-X', 'utf8', '-m', 'unittest', 'discover', '-s', 'tests', '-t', 'tests', '-v'], { cwd: join(root, 'engine'), env, stdio: 'inherit' })
if (browser && browser.exitCode === null) {
  const exited = new Promise((r) => browser.once('exit', r))
  browser.kill('SIGKILL')
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
}
if (profileDir) {
  try {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (error) {
    console.warn(`Could not remove the temporary browser profile ${profileDir}: ${error.message}`)
  }
}
process.exit(result.status ?? 1)
