#!/usr/bin/env node
/**
 * Prepares the bundled Python runtime for the automation engine.
 *
 *   node scripts/prepare-engine.mjs --platform=linux|win
 *
 * 1. Downloads the pinned python-build-standalone CPython and verifies its SHA-256.
 * 2. Extracts it to engine-runtime/<platform>/python.
 * 3. Installs the hash-locked wheels from engine/requirements.lock into that runtime's
 *    site-packages (for Windows, pip fetches win_amd64 wheels on any host).
 *
 * Needs a host Python 3 with pip at build time only. Customers never need Python:
 * electron-builder ships engine/ and engine-runtime/<os>/ as resources.
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE = '20260924'
const VERSION = '3.12.14'
const RUNTIMES = {
  win: { asset: `cpython-${VERSION}+${RELEASE}-x86_64-pc-windows-msvc-install_only.tar.gz`, sha256: 'c5303174bc29f5205decf6721ac549d4eb41c448f9b8c46cbc562d00348865bb', sitePackages: 'Lib/site-packages', pipPlatform: ['win_amd64'] },
  linux: { asset: `cpython-${VERSION}+${RELEASE}-x86_64-unknown-linux-gnu-install_only.tar.gz`, sha256: '5eae8cf79dd47fc2496a4fccc892936be831ce7a84d984b2299dfb1cdb592682', sitePackages: 'lib/python3.12/site-packages', pipPlatform: ['manylinux_2_28_x86_64', 'manylinux_2_17_x86_64', 'manylinux2014_x86_64', 'manylinux1_x86_64'] }
}

const arg = process.argv.find((a) => a.startsWith('--platform='))?.split('=')[1] ?? (process.platform === 'win32' ? 'win' : 'linux')
const spec = RUNTIMES[arg]
if (!spec) {
  console.error(`Unsupported platform "${arg}". Use --platform=win or --platform=linux.`)
  process.exit(1)
}

const cacheDir = join(root, 'engine-runtime', '.cache')
const outDir = join(root, 'engine-runtime', arg)
mkdirSync(cacheDir, { recursive: true })
const archive = join(cacheDir, spec.asset)

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

if (!existsSync(archive) || sha256(archive) !== spec.sha256) {
  const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE}/${encodeURIComponent(spec.asset)}`
  console.log(`Downloading ${spec.asset} …`)
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(archive))
}
const actual = sha256(archive)
if (actual !== spec.sha256) {
  rmSync(archive, { force: true })
  throw new Error(`Checksum mismatch for ${spec.asset}: expected ${spec.sha256}, got ${actual}`)
}
console.log(`Verified ${spec.asset} (sha256 ${actual.slice(0, 12)}…)`)

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const tar = spawnSync('tar', ['-xzf', archive, '-C', outDir], { stdio: 'inherit' })
if (tar.status !== 0) throw new Error('Extracting the runtime failed')

const hostPython = process.platform === 'win32' ? 'python' : 'python3'
const target = join(outDir, 'python', spec.sitePackages)
const pipArgs = [
  '-m', 'pip', 'install',
  '--no-cache-dir', '--disable-pip-version-check', '--no-compile',
  '--require-hashes', '--only-binary=:all:', '--no-deps',
  '--python-version', '3.12', '--implementation', 'cp',
  ...spec.pipPlatform.flatMap((p) => ['--platform', p]),
  '--target', target, '--upgrade',
  '-r', join(root, 'engine', 'requirements.lock')
]
// Optional offline install from a folder of already-downloaded wheels (hashes are still enforced).
if (process.env.ENGINE_WHEELS_DIR) pipArgs.push('--no-index', '--find-links', process.env.ENGINE_WHEELS_DIR)
console.log('Installing hash-locked engine dependencies …')
let pip
for (let attempt = 1; attempt <= 3; attempt++) {
  pip = spawnSync(hostPython, pipArgs, { stdio: 'inherit' })
  if (pip.status === 0) break
  console.warn(`pip failed (attempt ${attempt} of 3)${attempt < 3 ? ' — retrying' : ''}`)
}
if (pip.status !== 0) throw new Error('Installing the engine dependencies failed')

// Drop parts the engine never runs: debug symbols, Tcl/Tk and IDLE, C headers and
// import libraries, and the runtime's own pip (dependencies are installed above, at build time).
const base = join(outDir, 'python')
const lib = arg === 'win' ? join(base, 'Lib') : join(base, 'lib', 'python3.12')
const prune = [
  join(base, 'include'),
  join(lib, 'idlelib'), join(lib, 'tkinter'), join(lib, 'turtledemo'), join(lib, 'ensurepip'),
  ...(arg === 'win' ? [join(base, 'tcl'), join(base, 'libs'), join(base, 'Scripts')] : [join(base, 'lib', 'tcl9.0'), join(base, 'lib', 'tk9.0'), join(base, 'lib', 'tcl9')])
]
for (const name of readdirSync(join(lib, 'site-packages'))) if (/^pip(-|$)/.test(name)) prune.push(join(lib, 'site-packages', name))
const pdbs = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? pdbs(join(dir, e.name)) : e.name.endsWith('.pdb') ? [join(dir, e.name)] : []))
if (arg === 'win') prune.push(...pdbs(base))
for (const path of prune) rmSync(path, { recursive: true, force: true })

// Playwright's browser downloads are not used: the engine attaches to IX Browser's browser.
const python = join(outDir, 'python', arg === 'win' ? 'python.exe' : 'bin/python3')
if (!existsSync(python)) throw new Error(`Interpreter missing at ${python}`)
console.log(`Engine runtime ready: ${outDir}`)
