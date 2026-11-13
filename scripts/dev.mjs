#!/usr/bin/env node
/**
 * `npm run dev`: the app plus the local staging activation server, so the Subscription page works
 * without a second terminal. The server is watched: if it stops for any reason while the app runs,
 * it is started again. It stops with the app.
 *
 *   npm run dev                     app + staging server
 *   npm run dev -- --server-only    just the staging server (Ctrl+C to stop)
 *   npm run dev:app                 just the app (as before)
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const serverDir = join(root, 'server')
const serverOnly = process.argv.includes('--server-only')
const isWin = process.platform === 'win32'
// The address a development build uses unless XAUTO_ACTIVATION_URL says otherwise.
const activationUrl = (process.env.XAUTO_ACTIVATION_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '')
const WATCH_MS = 3000
const note = (text) => console.log(`[activation] ${text}`)

async function serverIsUp() {
  if (process.env.XAUTO_ACTIVATION_URL === 'none') return true
  try {
    return (await fetch(`${activationUrl}/healthz`, { signal: AbortSignal.timeout(1500) })).ok
  } catch {
    return false
  }
}

/** Why a local server can't be started here, or null when it can. */
function cannotStart() {
  if (process.env.XAUTO_ACTIVATION_URL) return `${activationUrl} is a custom address; start that server yourself`
  if (!existsSync(join(serverDir, '.env.staging'))) return 'server/.env.staging is missing (see server/README.md → Staging)'
  if (!existsSync(join(serverDir, 'node_modules', 'nodemailer'))) return 'server dependencies are missing: run `npm --prefix server ci`'
  return null
}

let child = null
let stopping = false

function startServer() {
  child = spawn(process.execPath, ['--no-warnings', 'src/index.mjs', '--env=.env.staging'], { cwd: serverDir, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => process.stdout.write(String(chunk).replace(/^(?=.)/gm, '[activation] ')))
  const started = child
  started.on('exit', (code, signal) => {
    if (!stopping) note(`server stopped (${signal ?? `exit ${code}`}); restarting`)
    if (child === started) child = null
  })
}

/** Keeps a server answering at the address the app uses, whoever started it. */
async function watch() {
  let warned = false
  for (;;) {
    if (stopping) return
    if (!(await serverIsUp()) && !child) {
      const reason = cannotStart()
      if (reason) {
        if (!warned) note(`not running, and can't start it: ${reason}. Subscription will show "can’t be reached".`)
        warned = true
      } else {
        startServer()
        for (let i = 0; i < 20 && !(await serverIsUp()); i++) await new Promise((r) => setTimeout(r, 250))
        note((await serverIsUp()) ? `staging server ready at ${activationUrl}` : 'staging server did not start; see the lines above')
        warned = false
      }
    }
    await new Promise((r) => setTimeout(r, WATCH_MS))
  }
}

if (await serverIsUp()) note(`already running at ${activationUrl}; watching it`)
const stop = () => {
  stopping = true
  if (child && !child.killed) child.kill()
}
process.on('exit', stop)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(0))
void watch()

if (serverOnly) note('Ctrl+C to stop')
else {
  const app = spawn(isWin ? 'npx.cmd' : 'npx', ['electron-vite', 'dev', ...process.argv.slice(2).filter((a) => a !== '--server-only')], { cwd: root, stdio: 'inherit', shell: isWin })
  app.on('exit', (code) => process.exit(code ?? 0))
}
