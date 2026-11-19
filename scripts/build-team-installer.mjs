#!/usr/bin/env node
/**
 * The team installer: a Windows installer with the email OTP settings built in, so any laptop it is
 * installed on shows the OTP activation page with no setup. It contains the SMTP password, so it is
 * SHARED PRIVATELY (WhatsApp, USB) and NEVER uploaded to GitHub. Public releases are built on GitHub
 * without it.
 *
 *   npm run dist:win:team
 *       settings from this PC's environment variables (XAUTO_SMTP_USER, XAUTO_SMTP_PASS,
 *       XAUTO_ADMIN_EMAIL and the optional XAUTO_* ones; Windows user variables are read too)
 *   npm run dist:win:team -- --test-sink-port=2526
 *       a test build that sends to a local SMTP capture server on that port, with made-up settings
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'
const NAMES = ['XAUTO_SMTP_HOST', 'XAUTO_SMTP_PORT', 'XAUTO_SMTP_SECURE', 'XAUTO_SMTP_USER', 'XAUTO_SMTP_PASS', 'XAUTO_SMTP_FROM', 'XAUTO_ADMIN_EMAIL', 'XAUTO_PLAN_CURRENCY', 'XAUTO_PRICE_MONTHLY', 'XAUTO_PRICE_SIX_MONTHS', 'XAUTO_PRICE_LIFETIME', 'XAUTO_PLAN_MONTHLY_DAYS']
const testPort = process.argv.find((a) => a.startsWith('--test-sink-port='))?.split('=')[1]

function windowsUserVariable(name) {
  if (!isWin) return ''
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', `[Environment]::GetEnvironmentVariable('${name}','User')`], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

const settings = {}
if (testPort) {
  Object.assign(settings, {
    XAUTO_SMTP_HOST: '127.0.0.1',
    XAUTO_SMTP_PORT: testPort,
    XAUTO_SMTP_SECURE: 'false',
    XAUTO_SMTP_USER: 'team-sender@example.com',
    XAUTO_SMTP_PASS: 'team-test-pass-5678',
    XAUTO_ADMIN_EMAIL: 'team-admin@example.com'
  })
} else {
  for (const name of NAMES) {
    const value = process.env[name]?.trim() || windowsUserVariable(name)
    if (value) settings[name] = value
  }
}
const missing = ['XAUTO_SMTP_USER', 'XAUTO_SMTP_PASS', 'XAUTO_ADMIN_EMAIL'].filter((n) => !settings[n])
if (missing.length) {
  console.error(`Missing ${missing.join(', ')}. Set them as Windows user environment variables (docs/security.md), then run this again.`)
  process.exit(1)
}

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const output = testPort ? 'release/team-test' : `release/${version}-team`
const run = (cmd, args, env) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: isWin, env })
  if (r.status !== 0) {
    console.error(`${cmd} ${args.join(' ')} failed`)
    process.exit(r.status ?? 1)
  }
}
const clean = { ...process.env }
for (const name of NAMES) delete clean[name]
delete clean.XAUTO_TEAM_BUILD

try {
  console.log(`Building the team installer ${version} (settings for ${settings.XAUTO_ADMIN_EMAIL})`)
  run('npx', ['electron-vite', 'build'], { ...clean, ...settings, XAUTO_TEAM_BUILD: '1' })
  run('npx', ['electron-builder', '--win', 'nsis', '--x64', '--publish', 'never', `-c.directories.output=${output}`, '-c.nsis.artifactName=X-Auto-${version}-windows-x64-team-setup.${ext}'], clean)
} finally {
  // Leave out/ as a normal build, without the settings.
  run('npx', ['electron-vite', 'build'], clean)
}
console.log(`\nTeam installer: ${join(root, output, `X-Auto-${version}-windows-x64-team-setup.exe`)}`)
console.log('It contains the email password. Share it privately; never upload it to GitHub or a public place.')
