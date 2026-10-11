#!/usr/bin/env node
/**
 * Release assets: the single definition of what a complete X Auto release contains, plus
 * validation of installers and auto-update metadata. Used by the release workflow and by
 * `npm run release` (to verify the published release).
 *
 *   node scripts/release-assets.mjs expected <version>            list required files (JSON)
 *   node scripts/release-assets.mjs prepare  <version> <dir>      merge per-arch mac metadata,
 *        validate every installer + metadata (sizes, SHA-512, file signatures), write
 *        SHA256SUMS.txt; exits non-zero on any problem. Prints a Markdown summary.
 */
import { createHash } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

export const PRODUCT = 'X-Auto'
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

export function parseVersion(version) {
  const m = SEMVER.exec(String(version ?? ''))
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] }
}

/** SemVer 2.0 precedence; > 0 when a is newer than b. */
export function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) throw new Error(`Not a valid version: ${!pa ? a : b}`)
  for (const k of ['major', 'minor', 'patch']) if (pa[k] !== pb[k]) return pa[k] - pb[k]
  if (!pa.pre.length && !pb.pre.length) return 0
  if (!pa.pre.length) return 1
  if (!pb.pre.length) return -1
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny && +x !== +y) return +x - +y
    if (nx !== ny) return nx ? -1 : 1
    if (!nx && x !== y) return x < y ? -1 : 1
  }
  return 0
}

/**
 * electron-builder's update channel for a version: "latest" for stable releases, otherwise the
 * first pre-release identifier (1.2.0-beta.1 → "beta"), so pre-releases never touch latest*.yml.
 */
export function updateChannel(version) {
  const p = parseVersion(version)
  if (!p) throw new Error(`Not a valid version: ${version}`)
  return p.pre.length && !/^\d+$/.test(p.pre[0]) ? p.pre[0] : 'latest'
}

/** Every file a complete release must contain (installers + update metadata). */
export function expectedAssets(version) {
  const v = version
  const channel = updateChannel(version)
  const installers = [
    { name: `${PRODUCT}-${v}-linux-x86_64.AppImage`, platform: 'Linux', arch: 'x64', type: 'AppImage', kind: 'appimage' },
    { name: `${PRODUCT}-${v}-linux-amd64.deb`, platform: 'Linux', arch: 'x64', type: 'Debian/Ubuntu package', kind: 'deb' },
    { name: `${PRODUCT}-${v}-windows-x64-setup.exe`, platform: 'Windows', arch: 'x64', type: 'Installer (NSIS)', kind: 'exe' },
    { name: `${PRODUCT}-${v}-windows-x64.zip`, platform: 'Windows', arch: 'x64', type: 'Portable ZIP', kind: 'zip' },
    { name: `${PRODUCT}-${v}-macos-x64.dmg`, platform: 'macOS', arch: 'x64 (Intel)', type: 'Disk image', kind: 'dmg' },
    { name: `${PRODUCT}-${v}-macos-arm64.dmg`, platform: 'macOS', arch: 'arm64 (Apple silicon)', type: 'Disk image', kind: 'dmg' },
    { name: `${PRODUCT}-${v}-macos-x64.zip`, platform: 'macOS', arch: 'x64 (Intel)', type: 'App archive (also used for updates)', kind: 'zip' },
    { name: `${PRODUCT}-${v}-macos-arm64.zip`, platform: 'macOS', arch: 'arm64 (Apple silicon)', type: 'App archive (also used for updates)', kind: 'zip' }
  ]
  const metadata = [
    { name: `${channel}.yml`, platform: 'Windows', arch: 'x64', type: 'Update metadata', kind: 'yml', covers: [`${PRODUCT}-${v}-windows-x64-setup.exe`] },
    { name: `${channel}-linux.yml`, platform: 'Linux', arch: 'x64', type: 'Update metadata', kind: 'yml', covers: [`${PRODUCT}-${v}-linux-x86_64.AppImage`] },
    { name: `${channel}-mac.yml`, platform: 'macOS', arch: 'x64 + arm64', type: 'Update metadata', kind: 'yml', covers: [`${PRODUCT}-${v}-macos-x64.zip`, `${PRODUCT}-${v}-macos-arm64.zip`] }
  ]
  return { channel, installers, metadata, all: [...installers, ...metadata] }
}

const MIN_INSTALLER_BYTES = 10 * 1024 * 1024

function readBytes(path, position, length) {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(length)
    const n = readSync(fd, buf, 0, length, position)
    return buf.subarray(0, n)
  } finally {
    closeSync(fd)
  }
}

/** Checks a file's leading bytes against its format (a renamed archive is not an installer). */
export function signatureProblem(kind, head, tail = Buffer.alloc(0)) {
  const starts = (sig, at = 0) => head.length >= at + sig.length && head.subarray(at, at + sig.length).equals(Buffer.from(sig))
  switch (kind) {
    case 'exe':
      return starts([0x4d, 0x5a]) ? null : 'not a Windows executable (no MZ header)'
    case 'zip':
      return starts([0x50, 0x4b, 0x03, 0x04]) ? null : 'not a ZIP archive'
    case 'appimage':
      return starts([0x7f, 0x45, 0x4c, 0x46]) && starts([0x41, 0x49, 0x02], 8) ? null : 'not a type-2 AppImage (ELF + AI\\x02 magic)'
    case 'deb':
      return starts([...Buffer.from('!<arch>\n')]) ? null : 'not a Debian package (ar archive)'
    case 'dmg': {
      const koly = tail.length >= 512 && tail.subarray(tail.length - 512, tail.length - 508).toString('latin1') === 'koly'
      return koly ? null : 'not a macOS disk image (no UDIF "koly" trailer)'
    }
    default:
      return null
  }
}

const sha512 = (path) => createHash('sha512').update(readFileSync(path)).digest('base64')

/**
 * Merges the per-architecture mac metadata produced on separate runners into one <channel>-mac.yml.
 * With `dir`, every entry's size and SHA-512 are recomputed from the final file in that folder, so
 * the metadata always describes the files that are actually published (never a runner's stale view).
 */
export function mergeMacMetadata(docs, dir = null) {
  if (!docs.length) throw new Error('No mac update metadata to merge')
  const versions = new Set(docs.map((d) => String(d.version)))
  if (versions.size !== 1) throw new Error(`mac metadata versions differ: ${[...versions].join(', ')}`)
  const files = []
  for (const d of docs) {
    for (const f of d.files ?? []) {
      if (files.some((x) => x.url === f.url)) throw new Error(`${f.url} is listed by more than one mac build — each runner must build only its own architecture`)
      if (!dir) {
        files.push(f)
        continue
      }
      const path = join(dir, String(f.url))
      if (!existsSync(path)) throw new Error(`mac metadata lists ${f.url}, which is not among the build files`)
      const actual = { size: statSync(path).size, sha512: sha512(path) }
      // Keep extra fields (e.g. blockMapSize) only when they belong to this exact file.
      files.push(actual.sha512 === f.sha512 && actual.size === Number(f.size) ? { ...f, ...actual } : { url: f.url, ...actual })
    }
  }
  // The legacy top-level path points at the Intel zip; electron-updater picks by arch from files[].
  const legacy = files.find((f) => /-x64\.zip$/.test(f.url)) ?? files.find((f) => f.url.endsWith('.zip')) ?? files[0]
  const releaseDate = docs.map((d) => d.releaseDate).filter(Boolean).sort().at(-1)
  return { version: docs[0].version, files, path: legacy.url, sha512: legacy.sha512, ...(releaseDate ? { releaseDate } : {}) }
}

/**
 * Validates a folder of release files for `version`. Returns { problems, summary }.
 * With `merge`, first combines <channel>-mac-x64.yml / <channel>-mac-arm64.yml into <channel>-mac.yml.
 */
export function prepareRelease(version, dir, { merge = true, minInstallerBytes = MIN_INSTALLER_BYTES } = {}) {
  const problems = []
  const { channel, installers, metadata, all } = expectedAssets(version)
  if (merge) {
    const parts = readdirSync(dir).filter((f) => new RegExp(`^${channel}-mac-(x64|arm64)\\.yml$`).test(f))
    if (parts.length) {
      try {
        const merged = mergeMacMetadata(
          parts.map((f) => yaml.load(readFileSync(join(dir, f), 'utf8'))),
          dir
        )
        writeFileSync(join(dir, `${channel}-mac.yml`), yaml.dump(merged, { lineWidth: -1 }))
        for (const f of parts) rmSync(join(dir, f))
      } catch (error) {
        problems.push(`mac metadata: ${error.message}`)
      }
    }
  }
  const present = new Set(readdirSync(dir))
  for (const a of all) if (!present.has(a.name)) problems.push(`missing ${a.name}`)

  for (const a of installers) {
    const path = join(dir, a.name)
    if (!existsSync(path)) continue
    const size = statSync(path).size
    if (size < minInstallerBytes) problems.push(`${a.name} is only ${size} bytes`)
    const head = readBytes(path, 0, 64)
    const tail = a.kind === 'dmg' ? readBytes(path, Math.max(0, size - 512), 512) : undefined
    const sig = signatureProblem(a.kind, head, tail)
    if (sig) problems.push(`${a.name}: ${sig}`)
  }

  for (const m of metadata) {
    const path = join(dir, m.name)
    if (!existsSync(path)) continue
    let doc
    try {
      doc = yaml.load(readFileSync(path, 'utf8'))
    } catch (error) {
      problems.push(`${m.name}: not valid YAML (${error.message})`)
      continue
    }
    if (String(doc?.version) !== version) problems.push(`${m.name}: version ${doc?.version} ≠ ${version}`)
    const files = Array.isArray(doc?.files) ? doc.files : []
    for (const covered of m.covers) if (!files.some((f) => f.url === covered)) problems.push(`${m.name}: does not reference ${covered}`)
    for (const f of files) {
      const target = join(dir, String(f.url))
      if (!existsSync(target)) {
        problems.push(`${m.name}: references ${f.url}, which is not in the release`)
        continue
      }
      if (Number(f.size) !== statSync(target).size) problems.push(`${m.name}: size of ${f.url} is ${f.size}, file is ${statSync(target).size}`)
      if (f.sha512 !== sha512(target)) problems.push(`${m.name}: SHA-512 of ${f.url} does not match the file`)
    }
  }

  if (!problems.length) {
    const names = readdirSync(dir).filter((f) => f !== 'SHA256SUMS.txt' && statSync(join(dir, f)).isFile()).sort()
    const sums = names.map((f) => `${createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')}  ${f}`).join('\n')
    writeFileSync(join(dir, 'SHA256SUMS.txt'), `${sums}\n`)
  }
  const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`
  const rows = all.map((a) => `| \`${a.name}\` | ${a.platform} | ${a.arch} | ${a.type} | ${existsSync(join(dir, a.name)) ? mb(statSync(join(dir, a.name)).size) : '**missing**'} |`)
  const summary = [
    `### X Auto ${version} — release files (${channel === 'latest' ? 'stable' : `pre-release channel “${channel}”`})`,
    '',
    '| File | Platform | Architecture | Type | Size |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    problems.length ? `**${problems.length} problem(s):**\n${problems.map((p) => `- ${p}`).join('\n')}` : 'All installers and update metadata validated (sizes, SHA-512, file signatures).'
  ].join('\n')
  return { problems, summary, channel }
}

/**
 * Combines the per-build artifact folders (one per runner) into one release folder. Two builds
 * producing a file with the same name is an error — never let one silently overwrite the other.
 */
export function collectArtifacts(partsDir, outDir) {
  const problems = []
  const origin = new Map()
  mkdirSync(outDir, { recursive: true })
  for (const part of readdirSync(partsDir).sort()) {
    const partPath = join(partsDir, part)
    if (!statSync(partPath).isDirectory()) continue
    for (const name of readdirSync(partPath)) {
      if (!statSync(join(partPath, name)).isFile()) continue
      if (origin.has(name)) {
        problems.push(`${name} was produced by both ${origin.get(name)} and ${part}`)
        continue
      }
      origin.set(name, part)
      copyFileSync(join(partPath, name), join(outDir, name))
    }
  }
  return problems
}

// ── remote verification (published release on GitHub) ──

/** Token for the GitHub API: GH_TOKEN/GITHUB_TOKEN (CI) or the GitHub CLI's login. Never printed. */
export function githubToken(run) {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  const r = run('gh', ['auth', 'token'])
  return r.status === 0 ? r.stdout.trim() : null
}

async function api(path, token) {
  const res = await fetch(`https://api.github.com/${path}`, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(30_000)
  })
  return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) }
}

/** First and last bytes of a release asset (proves it is downloadable and checks its format). */
async function assetBytes(repo, id, token, range) {
  // The API redirects to a signed download URL; fetch drops the Authorization header on that
  // cross-origin redirect (as it should) and keeps the Range header.
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/assets/${id}`, {
    headers: { Accept: 'application/octet-stream', Range: `bytes=${range}`, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000)
  })
  if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  // A server that ignores Range sends the whole file: keep only the requested slice.
  if (res.status === 200) {
    const [from, to] = range.split('-').map(Number)
    return buf.subarray(from, to + 1)
  }
  return buf
}

/**
 * Verifies a published release: not a draft, the right pre-release flag, every expected asset
 * uploaded with the right size, installers downloadable with the right file signature, and the
 * update metadata referencing the uploaded assets with matching sizes.
 */
export async function verifyRemoteRelease({ repo, version, token, localDir = null }) {
  const problems = []
  const tag = `v${version}`
  const { status, body: release } = await api(`repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, token)
  if (status !== 200 || !release) return { problems: [`no published GitHub Release for ${tag} (HTTP ${status})`], release: null, assets: [] }
  if (release.draft) problems.push(`${tag} is still a draft`)
  const prerelease = updateChannel(version) !== 'latest' || Boolean(parseVersion(version).pre.length)
  if (Boolean(release.prerelease) !== prerelease) problems.push(`${tag} pre-release flag is ${release.prerelease}, expected ${prerelease}`)
  const byName = new Map((release.assets ?? []).map((a) => [a.name, a]))
  const { installers, metadata, all } = expectedAssets(version)
  for (const a of all) {
    const remote = byName.get(a.name)
    if (!remote) {
      problems.push(`asset missing: ${a.name}`)
      continue
    }
    if (remote.state !== 'uploaded') problems.push(`${a.name} upload state is ${remote.state}`)
    if (!(remote.size > 0)) problems.push(`${a.name} is empty`)
    if (localDir && existsSync(join(localDir, a.name)) && statSync(join(localDir, a.name)).size !== remote.size) problems.push(`${a.name}: uploaded size ${remote.size} ≠ local ${statSync(join(localDir, a.name)).size}`)
  }
  for (const a of installers) {
    const remote = byName.get(a.name)
    if (!remote) continue
    try {
      const head = await assetBytes(repo, remote.id, token, '0-63')
      // Explicit start-end range: GitHub's download storage answers suffix ranges (bytes=-512) with 501.
      const tail = a.kind === 'dmg' ? await assetBytes(repo, remote.id, token, `${remote.size - 512}-${remote.size - 1}`) : undefined
      const sig = signatureProblem(a.kind, head, tail)
      if (sig) problems.push(`${a.name} (downloaded): ${sig}`)
    } catch (error) {
      problems.push(`${a.name} could not be downloaded: ${error.message}`)
    }
  }
  for (const m of metadata) {
    const remote = byName.get(m.name)
    if (!remote) continue
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/releases/assets/${remote.id}`, { headers: { Accept: 'application/octet-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(60_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const doc = yaml.load(await res.text())
      if (String(doc?.version) !== version) problems.push(`${m.name} (downloaded): version ${doc?.version} ≠ ${version}`)
      for (const f of doc?.files ?? []) {
        const target = byName.get(String(f.url))
        if (!target) problems.push(`${m.name} references ${f.url}, which is not in the release`)
        else if (Number(f.size) !== target.size) problems.push(`${m.name}: ${f.url} size ${f.size} ≠ uploaded ${target.size}`)
      }
    } catch (error) {
      problems.push(`${m.name} could not be downloaded: ${error.message}`)
    }
  }
  // Installed apps read the feed without credentials: check it the way they will.
  const channel = updateChannel(version)
  let anonymousFeed = false
  try {
    const res = await fetch(`https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${channel}.yml`, { redirect: 'follow', signal: AbortSignal.timeout(30_000) })
    anonymousFeed = res.ok && String(yaml.load(await res.text())?.version) === version
  } catch {
    anonymousFeed = false
  }
  const assets = all.map((a) => ({ name: a.name, platform: a.platform, arch: a.arch, url: byName.get(a.name)?.browser_download_url ?? null, size: byName.get(a.name)?.size ?? null }))
  return { problems, release: { url: release.html_url, draft: release.draft, prerelease: release.prerelease, publishedAt: release.published_at }, assets, anonymousFeed }
}

// ── CLI ──
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, version, dir] = process.argv.slice(2)
  if (cmd === 'collect') {
    // collect <parts-dir> <out-dir>
    const problems = collectArtifacts(version, dir)
    for (const p of problems) console.error(`✗ ${p}`)
    if (!problems.length) console.log(`Collected ${readdirSync(dir).length} files into ${dir}`)
    process.exit(problems.length ? 1 : 0)
  }
  if (!parseVersion(version)) {
    console.error('Usage: release-assets.mjs expected <version> | prepare <version> <dir> | collect <parts-dir> <out-dir> | verify-remote <version> <owner/repo> [dir]')
    process.exit(2)
  }
  if (cmd === 'expected') {
    console.log(JSON.stringify(expectedAssets(version), null, 2))
  } else if (cmd === 'prepare') {
    const { problems, summary } = prepareRelease(version, dir)
    console.log(summary)
    if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, { flag: 'a' })
    process.exit(problems.length ? 1 : 0)
  } else if (cmd === 'verify-remote') {
    // verify-remote <version> <owner/repo> [local-dir]
    const repo = dir
    const localDir = process.argv[5] ?? null
    const { spawnSync } = await import('node:child_process')
    const token = githubToken((c, a) => spawnSync(c, a, { encoding: 'utf8' }))
    const result = await verifyRemoteRelease({ repo, version, token, localDir })
    const lines = [
      `### Published release check — v${version}`,
      '',
      result.release ? `Release: ${result.release.url} (${result.release.draft ? 'draft' : 'published'}${result.release.prerelease ? ', pre-release' : ''})` : 'Release: not found',
      '',
      ...result.assets.map((a) => `- ${a.url ? `[${a.name}](${a.url})` : `${a.name} — **missing**`}`),
      '',
      result.anonymousFeed ? 'Update feed: readable without credentials — installed apps can discover this release.' : '**Update feed: NOT readable without credentials** (private repository?). Installed apps cannot discover this release until the releases are public.',
      '',
      result.problems.length ? `**${result.problems.length} problem(s):**\n${result.problems.map((p) => `- ${p}`).join('\n')}` : 'All assets uploaded, downloadable and consistent with the update metadata.'
    ].join('\n')
    console.log(lines)
    if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines}\n`, { flag: 'a' })
    process.exit(result.problems.length ? 1 : 0)
  } else {
    console.error(`Unknown command ${cmd}`)
    process.exit(2)
  }
}
