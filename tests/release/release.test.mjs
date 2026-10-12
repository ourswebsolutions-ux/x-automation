// Release tooling tests (plain Node): version rules, the required asset list, installer signature
// checks, mac metadata merging, full-set validation, and the release command's safety (dry run
// restores the version files byte-for-byte; failures change nothing). No network, no GitHub.
//   node tests/release/release.test.mjs
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { collectArtifacts, compareVersions, expectedAssets, mergeMacMetadata, prepareRelease, signatureProblem, updateChannel, verifyRemoteRelease } from '../../scripts/release-assets.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const results = []
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + String(extra).slice(0, 300) : ''}`)

// ── versions & channels ──
check('versions: ordering incl. pre-releases', compareVersions('1.0.1', '1.0.0') > 0 && compareVersions('1.0.0', '1.0.0-rc.1') > 0 && compareVersions('1.0.0-beta.11', '1.0.0-beta.2') > 0 && compareVersions('1.0.0-alpha', '1.0.0-alpha.1') < 0 && compareVersions('2.0.0', '2.0.0') === 0)
check('channels: stable → latest, pre-release → its name', updateChannel('1.0.1') === 'latest' && updateChannel('1.1.0-beta.3') === 'beta' && updateChannel('2.0.0-rc.1') === 'rc')

// ── required assets ──
const exp = expectedAssets('1.0.1')
const names = exp.all.map((a) => a.name)
const required = [
  'X-Auto-1.0.1-linux-x86_64.AppImage',
  'X-Auto-1.0.1-linux-amd64.deb',
  'X-Auto-1.0.1-windows-x64-setup.exe',
  'X-Auto-1.0.1-windows-x64.zip',
  'X-Auto-1.0.1-macos-x64.dmg',
  'X-Auto-1.0.1-macos-arm64.dmg',
  'X-Auto-1.0.1-macos-x64.zip',
  'X-Auto-1.0.1-macos-arm64.zip',
  'latest.yml',
  'latest-linux.yml',
  'latest-mac.yml'
]
check('every required installer and metadata file is expected', required.every((n) => names.includes(n)) && names.length === required.length, names.join(', '))
check('pre-release metadata uses its own channel files', expectedAssets('1.1.0-beta.1').metadata.map((m) => m.name).join() === 'beta.yml,beta-linux.yml,beta-mac.yml')

// ── installer signatures ──
const pad = (b) => Buffer.concat([Buffer.from(b), Buffer.alloc(64)])
const appimageHead = pad([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0x41, 0x49, 0x02])
const dmgTail = Buffer.concat([Buffer.alloc(512 - 4 - 508 + 0), Buffer.from('koly'), Buffer.alloc(508)])
check('signatures: real formats accepted', !signatureProblem('exe', pad('MZ')) && !signatureProblem('zip', pad([0x50, 0x4b, 3, 4])) && !signatureProblem('appimage', appimageHead) && !signatureProblem('deb', pad('!<arch>\n')) && !signatureProblem('dmg', pad('x'), dmgTail))
check('signatures: a ZIP renamed to .exe is rejected', /MZ/.test(signatureProblem('exe', pad([0x50, 0x4b, 3, 4])) ?? ''))
check('signatures: a plain ELF is not an AppImage; a non-UDIF file is not a dmg', Boolean(signatureProblem('appimage', pad([0x7f, 0x45, 0x4c, 0x46]))) && Boolean(signatureProblem('dmg', pad('x'), Buffer.alloc(512))))

// ── mac metadata merge ──
const macX = { version: '1.0.1', files: [{ url: 'X-Auto-1.0.1-macos-x64.zip', sha512: 'a', size: 1 }, { url: 'X-Auto-1.0.1-macos-x64.dmg', sha512: 'b', size: 2 }], path: 'X-Auto-1.0.1-macos-x64.zip', sha512: 'a', releaseDate: '2026-10-11T10:00:00.000Z' }
const macA = { version: '1.0.1', files: [{ url: 'X-Auto-1.0.1-macos-arm64.zip', sha512: 'c', size: 3 }], path: 'X-Auto-1.0.1-macos-arm64.zip', sha512: 'c', releaseDate: '2026-10-11T10:05:00.000Z' }
const merged = mergeMacMetadata([macA, macX])
check('mac merge: both arches listed, legacy path = Intel zip, newest date', merged.files.length === 3 && merged.path === 'X-Auto-1.0.1-macos-x64.zip' && merged.releaseDate === '2026-10-11T10:05:00.000Z')
let mismatch = false
try { mergeMacMetadata([macA, { ...macX, version: '1.0.2' }]) } catch { mismatch = true }
check('mac merge: refuses mixed versions', mismatch)

// ── full-set validation with synthetic installers ──
const dir = mkdtempSync(join(tmpdir(), 'axora-rel-'))
const v = '1.0.1'
const body = (head, tail = Buffer.alloc(0)) => Buffer.concat([head, Buffer.alloc(4096, 7), tail])
const files = {
  [`X-Auto-${v}-linux-x86_64.AppImage`]: body(appimageHead),
  [`X-Auto-${v}-linux-amd64.deb`]: body(pad('!<arch>\n')),
  [`X-Auto-${v}-windows-x64-setup.exe`]: body(pad('MZ')),
  [`X-Auto-${v}-windows-x64.zip`]: body(pad([0x50, 0x4b, 3, 4])),
  [`X-Auto-${v}-macos-x64.dmg`]: body(pad('x'), dmgTail),
  [`X-Auto-${v}-macos-arm64.dmg`]: body(pad('x'), dmgTail),
  [`X-Auto-${v}-macos-x64.zip`]: body(pad([0x50, 0x4b, 3, 4])),
  [`X-Auto-${v}-macos-arm64.zip`]: body(pad([0x50, 0x4b, 3, 4]))
}
for (const [n, b] of Object.entries(files)) writeFileSync(join(dir, n), b)
const entry = (n) => ({ url: n, sha512: createHash('sha512').update(files[n]).digest('base64'), size: files[n].length })
writeFileSync(join(dir, 'latest.yml'), yaml.dump({ version: v, files: [entry(`X-Auto-${v}-windows-x64-setup.exe`)], path: `X-Auto-${v}-windows-x64-setup.exe` }))
writeFileSync(join(dir, 'latest-linux.yml'), yaml.dump({ version: v, files: [entry(`X-Auto-${v}-linux-x86_64.AppImage`), entry(`X-Auto-${v}-linux-amd64.deb`)] }))
writeFileSync(join(dir, 'latest-mac-x64.yml'), yaml.dump({ version: v, files: [entry(`X-Auto-${v}-macos-x64.zip`)] }))
writeFileSync(join(dir, 'latest-mac-arm64.yml'), yaml.dump({ version: v, files: [entry(`X-Auto-${v}-macos-arm64.zip`)] }))
let res = prepareRelease(v, dir, { minInstallerBytes: 1024 })
check('complete set validates; per-arch mac metadata merged; checksums written', res.problems.length === 0 && yaml.load(readFileSync(join(dir, 'latest-mac.yml'), 'utf8')).files.length === 2 && readFileSync(join(dir, 'SHA256SUMS.txt'), 'utf8').includes('windows-x64-setup.exe'), res.problems.join('; '))

// tampered installer → SHA-512 mismatch caught
writeFileSync(join(dir, `X-Auto-${v}-linux-x86_64.AppImage`), body(appimageHead, Buffer.from('changed')))
res = prepareRelease(v, dir, { minInstallerBytes: 1024 })
check('tampered file: metadata SHA-512/size mismatch detected', res.problems.some((p) => p.includes('latest-linux.yml') && (p.includes('SHA-512') || p.includes('size'))), res.problems.join('; '))
writeFileSync(join(dir, `X-Auto-${v}-linux-x86_64.AppImage`), files[`X-Auto-${v}-linux-x86_64.AppImage`])

// missing platform → refused (no partial release)
rmSync(join(dir, `X-Auto-${v}-macos-arm64.dmg`))
res = prepareRelease(v, dir, { minInstallerBytes: 1024 })
check('missing installer: release refused', res.problems.some((p) => p === `missing X-Auto-${v}-macos-arm64.dmg`))
writeFileSync(join(dir, `X-Auto-${v}-macos-arm64.dmg`), files[`X-Auto-${v}-macos-arm64.dmg`])

// wrong version in metadata, empty installer, renamed archive
writeFileSync(join(dir, 'latest.yml'), yaml.dump({ version: '1.0.0', files: [entry(`X-Auto-${v}-windows-x64-setup.exe`)] }))
writeFileSync(join(dir, `X-Auto-${v}-windows-x64-setup.exe`), files[`X-Auto-${v}-windows-x64.zip`])
res = prepareRelease(v, dir, { minInstallerBytes: 1024 })
check('wrong metadata version and a ZIP posing as the installer are both caught', res.problems.some((p) => p.includes('version 1.0.0')) && res.problems.some((p) => p.includes('not a Windows executable')), res.problems.join('; '))
res = prepareRelease(v, dir)
check('tiny installers are rejected at the real size threshold', res.problems.some((p) => /is only \d+ bytes/.test(p)))
rmSync(dir, { recursive: true, force: true })

// ── mac metadata from two runners (the v1.0.1 failure: stale sizes / hashes, colliding files) ──
{
  const build = () => {
    const d = mkdtempSync(join(tmpdir(), 'axora-mac-'))
    for (const [n, b] of Object.entries(files)) writeFileSync(join(d, n), b)
    writeFileSync(join(d, 'latest.yml'), yaml.dump({ version: v, files: [entry(`X-Auto-${v}-windows-x64-setup.exe`)], path: `X-Auto-${v}-windows-x64-setup.exe` }))
    writeFileSync(join(d, 'latest-linux.yml'), yaml.dump({ version: v, files: [entry(`X-Auto-${v}-linux-x86_64.AppImage`), entry(`X-Auto-${v}-linux-amd64.deb`)] }))
    return d
  }
  const stale = (n) => ({ url: n, sha512: createHash('sha512').update('a different build').digest('base64'), size: 12345, blockMapSize: 99 })
  const half = (d, arch, list) => writeFileSync(join(d, `latest-mac-${arch}.yml`), yaml.dump({ version: v, files: list, path: list[0]?.url, sha512: list[0]?.sha512, releaseDate: '2026-10-11T12:00:00.000Z' }))
  const macFiles = (arch) => [`X-Auto-${v}-macos-${arch}.zip`, `X-Auto-${v}-macos-${arch}.dmg`]

  // 1. Halves whose sizes/hashes don't match the final files → rebuilt from the files, release valid.
  let d = build()
  half(d, 'x64', macFiles('x64').map(stale))
  half(d, 'arm64', macFiles('arm64').map(stale))
  let res = prepareRelease(v, d, { minInstallerBytes: 1024 })
  const mac = yaml.load(readFileSync(join(d, 'latest-mac.yml'), 'utf8'))
  const matches = (f) => f.size === files[f.url].length && f.sha512 === createHash('sha512').update(files[f.url]).digest('base64')
  check('mac merge: stale sizes and hashes are replaced by the real ones of the final files', res.problems.length === 0 && mac.files.length === 4 && mac.files.every(matches), res.problems.join('; ') + JSON.stringify(mac.files.map((f) => [f.url, f.size])))
  check('mac merge: a stale blockMapSize from another build is dropped', mac.files.every((f) => f.blockMapSize === undefined))
  check('mac merge: both architectures listed with their own filenames; legacy path = Intel zip with its real hash', ['x64', 'arm64'].every((a) => mac.files.some((f) => f.url === `X-Auto-${v}-macos-${a}.zip`)) && mac.path === `X-Auto-${v}-macos-x64.zip` && mac.sha512 === createHash('sha512').update(files[`X-Auto-${v}-macos-x64.zip`]).digest('base64'))
  rmSync(d, { recursive: true, force: true })

  // 2. One runner built both arches (what the pinned target arch caused) → refused, not silently merged.
  d = build()
  half(d, 'x64', [...macFiles('x64'), ...macFiles('arm64')].map(entry))
  half(d, 'arm64', [...macFiles('arm64'), ...macFiles('x64')].map(entry))
  res = prepareRelease(v, d, { minInstallerBytes: 1024 })
  check('mac merge: the same file listed by both mac builds is refused', res.problems.some((p) => p.includes('listed by more than one mac build')), res.problems.join('; '))
  rmSync(d, { recursive: true, force: true })

  // 3. Missing Apple-silicon build → refused (no release without both mac architectures).
  d = build()
  for (const n of macFiles('arm64')) rmSync(join(d, n))
  half(d, 'x64', macFiles('x64').map(entry))
  res = prepareRelease(v, d, { minInstallerBytes: 1024 })
  check('mac merge: missing arm64 build → missing files and metadata entry reported', res.problems.includes(`missing X-Auto-${v}-macos-arm64.zip`) && res.problems.some((p) => p.includes(`does not reference X-Auto-${v}-macos-arm64.zip`)), res.problems.join('; '))
  rmSync(d, { recursive: true, force: true })

  // 4. A half pointing at a file that isn't among the build files → refused.
  d = build()
  half(d, 'x64', macFiles('x64').map(entry))
  half(d, 'arm64', [...macFiles('arm64').map(entry), { url: `X-Auto-${v}-macos-arm64-extra.zip`, sha512: 'x', size: 1 }])
  res = prepareRelease(v, d, { minInstallerBytes: 1024 })
  check('mac merge: an entry for a file that was not built is refused', res.problems.some((p) => p.includes('not among the build files')), res.problems.join('; '))
  rmSync(d, { recursive: true, force: true })
}

// ── combining the per-build artifact folders ──
{
  const parts = mkdtempSync(join(tmpdir(), 'axora-parts-'))
  const out = join(parts, '..', `${basename(parts)}-out`)
  mkdirSync(join(parts, 'x-auto-macos-arm64'))
  mkdirSync(join(parts, 'x-auto-macos-x64'))
  writeFileSync(join(parts, 'x-auto-macos-arm64', `X-Auto-${v}-macos-arm64.zip`), 'arm')
  writeFileSync(join(parts, 'x-auto-macos-x64', `X-Auto-${v}-macos-x64.zip`), 'intel')
  let problems = collectArtifacts(parts, out)
  check('collect: distinct files from each build are combined', problems.length === 0 && readFileSync(join(out, `X-Auto-${v}-macos-x64.zip`), 'utf8') === 'intel' && readFileSync(join(out, `X-Auto-${v}-macos-arm64.zip`), 'utf8') === 'arm', problems.join('; '))
  writeFileSync(join(parts, 'x-auto-macos-x64', `X-Auto-${v}-macos-arm64.zip`), 'intel runner built arm64 too')
  rmSync(out, { recursive: true, force: true })
  problems = collectArtifacts(parts, out)
  check('collect: the same filename from two builds is an error (no silent overwrite)', problems.some((p) => p.includes(`X-Auto-${v}-macos-arm64.zip was produced by both`)) && readFileSync(join(out, `X-Auto-${v}-macos-arm64.zip`), 'utf8') === 'arm', problems.join('; '))
  rmSync(parts, { recursive: true, force: true })
  rmSync(out, { recursive: true, force: true })
}

// ── remote verification against GitHub's download behaviour (no network: fetch is stubbed) ──
{
  const v2 = '1.0.2'
  const exp2 = expectedAssets(v2)
  const bodies = {}
  for (const a of exp2.installers) {
    const head = a.kind === 'exe' ? pad('MZ') : a.kind === 'zip' ? pad([0x50, 0x4b, 3, 4]) : a.kind === 'appimage' ? appimageHead : a.kind === 'deb' ? pad('!<arch>\n') : pad('x')
    bodies[a.name] = a.kind === 'dmg' ? Buffer.concat([head, Buffer.alloc(2048), dmgTail]) : Buffer.concat([head, Buffer.alloc(2048)])
  }
  const meta = (names) => yaml.dump({ version: v2, files: names.map((n) => ({ url: n, sha512: 'x', size: bodies[n].length })) })
  bodies['latest.yml'] = Buffer.from(meta([`X-Auto-${v2}-windows-x64-setup.exe`]))
  bodies['latest-linux.yml'] = Buffer.from(meta([`X-Auto-${v2}-linux-x86_64.AppImage`, `X-Auto-${v2}-linux-amd64.deb`]))
  bodies['latest-mac.yml'] = Buffer.from(meta([`X-Auto-${v2}-macos-x64.zip`, `X-Auto-${v2}-macos-arm64.zip`]))
  const assets = Object.keys(bodies).map((name, i) => ({ id: i + 1, name, size: bodies[name].length, state: 'uploaded', browser_download_url: `https://github.com/o/r/releases/download/v${v2}/${name}` }))
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url)
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } })
    if (u.includes('/releases/tags/')) return json({ draft: false, prerelease: false, html_url: 'https://github.com/o/r/releases/tag/v1.0.2', assets })
    const byId = /\/releases\/assets\/(\d+)$/.exec(u)
    const name = byId ? assets[Number(byId[1]) - 1].name : u.split('/').pop()
    const body = bodies[name]
    const range = opts.headers?.Range
    if (!range) return new Response(body, { status: 200 })
    // Like GitHub's download storage: suffix ranges are not implemented.
    if (/^bytes=-/.test(range)) return new Response('', { status: 501 })
    const [, from, to] = /^bytes=(\d+)-(\d+)$/.exec(range)
    return new Response(body.subarray(Number(from), Number(to) + 1), { status: 206 })
  }
  try {
    const result = await verifyRemoteRelease({ repo: 'o/r', version: v2, token: null })
    check('remote verify: DMG trailers read with explicit byte ranges (GitHub answers suffix ranges with 501)', result.problems.length === 0, result.problems.join('; '))
  } finally {
    globalThis.fetch = realFetch
  }
}

// ── build configuration guard ──
{
  const config = yaml.load(readFileSync(join(root, 'electron-builder.yml'), 'utf8'))
  const macTargets = config.mac.target.map((t) => (typeof t === 'string' ? { target: t } : t))
  check('electron-builder: mac targets leave the arch to the CLI (an explicit arch overrides --arm64/--x64)', macTargets.length >= 2 && macTargets.every((t) => t.arch === undefined && !String(t.target).includes(':')), JSON.stringify(macTargets))
  check('electron-builder: Linux, Windows and both mac formats still configured', ['AppImage', 'deb'].every((t) => config.linux.target.some((x) => x.target === t)) && ['nsis', 'zip'].every((t) => config.win.target.some((x) => x.target === t)) && ['dmg', 'zip'].every((t) => macTargets.some((x) => x.target === t)))
}

// ── the release command in a scratch repository (offline, never touches GitHub) ──
const scratch = mkdtempSync(join(tmpdir(), 'axora-relcmd-'))
mkdirSync(join(scratch, 'scripts'))
cpSync(join(root, 'scripts/release.mjs'), join(scratch, 'scripts/release.mjs'))
cpSync(join(root, 'scripts/release-assets.mjs'), join(scratch, 'scripts/release-assets.mjs'))
// The release scripts' only package (and its dependency), copied: symlinks need extra rights on Windows.
for (const name of ['js-yaml', 'argparse']) cpSync(join(root, 'node_modules', name), join(scratch, 'node_modules', name), { recursive: true })
// Unusual but valid formatting: a byte-exact restore must keep it, a re-serialisation would not.
const pkg = '{\n    "name": "scratch-app",\n    "version": "0.5.0",\n    "private": true,\n    "type": "module"\n}'
const lock = '{\n    "name": "scratch-app",\n    "version": "0.5.0",\n    "lockfileVersion": 3,\n    "requires": true,\n    "packages": {\n        "": {\n            "name": "scratch-app",\n            "version": "0.5.0"\n        }\n    }\n}'
writeFileSync(join(scratch, 'package.json'), pkg)
writeFileSync(join(scratch, 'package-lock.json'), lock)
writeFileSync(join(scratch, '.gitignore'), 'node_modules\n')
const sh = (cmd, a, env = {}) => spawnSync(cmd, a, { cwd: scratch, encoding: 'utf8', env: { ...process.env, ...env } })
sh('git', ['init', '-q', '-b', 'main'])
sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'])
sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'])
sh('git', ['remote', 'add', 'origin', 'https://github.com/example-owner/example-repo.git'])
const ghHome = mkdtempSync(join(tmpdir(), 'axora-gh-')) // a GitHub CLI config with no login
const env = { GH_CONFIG_DIR: ghHome, GH_TOKEN: '', GITHUB_TOKEN: '', AXORA_RELEASE_SELFTEST: '1', NO_COLOR: '1' }
const release = (...a) => sh(process.execPath, ['scripts/release.mjs', ...a], env)
const unchanged = () => readFileSync(join(scratch, 'package.json'), 'utf8') === pkg && readFileSync(join(scratch, 'package-lock.json'), 'utf8') === lock
const head0 = sh('git', ['rev-parse', 'HEAD']).stdout.trim()
const state = () => ({ head: sh('git', ['rev-parse', 'HEAD']).stdout.trim(), tags: sh('git', ['tag', '-l']).stdout.trim(), dirty: sh('git', ['status', '--porcelain']).stdout.trim() })

let r = release('0.6.0', '--dry-run')
let st = state()
check('dry run: succeeds, bumps then restores both version files byte-for-byte', r.status === 0 && unchanged() && /restored byte-for-byte/.test(r.stdout), (r.stdout + r.stderr).slice(-400))
check('dry run: no commit, no tag, clean tree', st.head === head0 && st.tags === '' && st.dirty === '', JSON.stringify(st))
check('dry run: lists the files a real run would publish', r.stdout.includes('X-Auto-0.6.0-windows-x64-setup.exe') && r.stdout.includes('latest-mac.yml'))

r = release('0.6.0')
check('real run without GitHub login: stops before any change, with the fix', r.status === 1 && /not logged in|not installed/.test(r.stderr) && /gh auth login|cli\.github\.com/.test(r.stderr) && unchanged() && state().head === head0 && state().tags === '', r.stderr.slice(-300))
check('invalid version refused', release('abc', '--dry-run').status === 1 && unchanged())
check('older or equal version refused', /not newer/.test(release('0.5.0', '--dry-run').stderr) && /not newer/.test(release('0.4.9', '--dry-run').stderr))
check('numeric-only pre-release refused (would mix with the stable channel)', /must start with a name/.test(release('0.6.0-1', '--dry-run').stderr))
check('pre-release dry run works', release('0.6.0-beta.1', '--dry-run').status === 0 && unchanged())
writeFileSync(join(scratch, 'notes.txt'), 'uncommitted')
r = release('0.6.0', '--dry-run')
check('uncommitted changes refused (and left untouched)', r.status === 1 && /uncommitted/.test(r.stderr) && readFileSync(join(scratch, 'notes.txt'), 'utf8') === 'uncommitted' && unchanged())
rmSync(join(scratch, 'notes.txt'))
sh('git', ['switch', '-q', '-c', 'feature'])
check('releases only from main', /Releases are made from main/.test(release('0.6.0', '--dry-run').stderr))
sh('git', ['switch', '-q', 'main'])
sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'tag', '-a', 'v0.7.0', '-m', 'existing'])
r = release('0.7.0', '--dry-run')
check('existing tag: never moved or deleted (dry run reports it)', r.status === 0 && /already exists/.test(r.stdout) && sh('git', ['rev-parse', 'v0.7.0^{commit}']).stdout.trim() === head0 && unchanged())

rmSync(scratch, { recursive: true, force: true })
rmSync(ghHome, { recursive: true, force: true })

console.log(results.join('\n'))
const failed = results.filter((x) => x.startsWith('FAIL')).length
console.log(`\n${failed} failed of ${results.length}`)
process.exit(failed ? 1 : 0)
