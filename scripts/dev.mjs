#!/usr/bin/env node
/**
 * `npm run dev`: the app plus, when it isn't already running, the local staging activation server,
 * so the Subscription page works without a second terminal. The server stops with the app.
 *
 *   npm run dev                 app + staging server
 *   npm run dev -- --server-only    just the staging server (Ctrl+C to stop)
 *   npm run dev:app             just the app (as before)
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
const note = (text) => console.log(`[activation] ${text}`)

async function serverIsUp() {
  try {
    return (await fetch(`${activationUrl}/healthz`, { signal: AbortSignal.timeout(1500) })).ok
  } catch {
    return false
  }
}

async function startServer() {
  if (await serverIsUp()) {
    note(`already running at ${activationUrl}`)
    return null
  }
  if (process.env.XAUTO_ACTIVATION_URL) {
    note(`${activationUrl} isn't answering; not starting a local server for a custom address`)
    return null
  }
  if (!existsSync(join(serverDir, '.env.staging'))) {
    note('server/.env.staging is missing, so Subscription will show "can’t be reached". See server/README.md → Staging.')
    return null
  }
  if (!existsSync(join(serverDir, 'node_modules', 'nodemailer'))) {
    note('server dependencies are missing: run `npm --prefix server ci`, then `npm run dev` again.')
    return null
  }
  const child = spawn(process.execPath, ['--no-warnings', 'src/index.mjs', '--env=.env.staging'], { cwd: serverDir, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => process.stdout.write(String(chunk).replace(/^(?=.)/gm, '[activation] ')))
  child.on('exit', (code) => code && note(`stopped (exit ${code})`))
  for (let i = 0; i < 20 && !(await serverIsUp()); i++) await new Promise((r) => setTimeout(r, 250))
  note((await serverIsUp()) ? `staging server ready at ${activationUrl}` : 'staging server did not start; Subscription will show "can’t be reached"')
  return child
}

const server = await startServer()
const stop = () => server && !server.killed && server.kill()
process.on('exit', stop)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0))

if (serverOnly) {
  if (!server) process.exit(0)
  note('Ctrl+C to stop')
} else {
  const app = spawn(isWin ? 'npx.cmd' : 'npx', ['electron-vite', 'dev', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit', shell: isWin })
  app.on('exit', (code) => process.exit(code ?? 0))
}
