#!/usr/bin/env node
/**
 * One-command release:   npm run release -- 1.0.0   [--dry-run] [--e2e]
 *
 * 1. Validates the version (X.Y.Z or X.Y.Z-pre), that it is newer than package.json,
 *    that the tag vX.Y.Z doesn't exist locally or on origin.
 * 2. Requires a clean working tree on main, up to date with origin/main.
 * 3. Sets the version in package.json and package-lock.json.
 * 4. Runs typecheck, unit tests and engine tests (and the E2E test with --e2e).
 * 5. Commits "Release vX.Y.Z", creates the annotated tag and pushes main + tag together
 *    (git push --atomic). The tag push starts .github/workflows/release.yml, which builds
 *    Linux, Windows and macOS and publishes the GitHub Release.
 *
 * Nothing is committed or pushed if any check fails; the version change is undone.
 * --dry-run does every check and test, then undoes the version change without committing.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const withE2e = args.includes('--e2e')
const input = args.find((a) => !a.startsWith('--'))
const isWin = process.platform === 'win32'

const step = (n, text) => console.log(`\n\x1b[1m[${n}/6] ${text}\x1b[0m`)
const ok = (text) => console.log(`  \x1b[32m✓\x1b[0m ${text}`)
const fail = (text, hint) => {
  console.error(`\n\x1b[31m✗ ${text}\x1b[0m${hint ? `\n  ${hint}` : ''}\n\nNothing was committed, tagged or pushed.`)
  process.exit(1)
}
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const run = (cmd, cmdArgs, { drop = [] } = {}) => {
  const env = { ...process.env }
  for (const key of drop) delete env[key]
  return spawnSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit', shell: isWin, env }).status === 0
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const parse = (v) => {
  const m = SEMVER.exec(v)
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null } : null
}
// > 0 when a is newer than b (a release is newer than its pre-releases).
const compare = (a, b) => {
  for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return a.nums[i] - b.nums[i]
  if (a.pre === b.pre) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1
  return a.pre.localeCompare(b.pre, undefined, { numeric: true })
}

// ── 1. version ──
step(1, 'Checking the version')
if (!input) fail('No version given.', 'Usage: npm run release -- 1.0.0   (add --dry-run to test without pushing)')
const version = input.replace(/^v/, '')
const next = parse(version)
if (!next) fail(`"${input}" is not a valid version.`, 'Use MAJOR.MINOR.PATCH, e.g. 1.0.0 or 1.1.0-beta.1')
const pkgPath = join(root, 'package.json')
const current = JSON.parse(readFileSync(pkgPath, 'utf8')).version
if (compare(next, parse(current)) <= 0) fail(`Version ${version} is not newer than the current version ${current}.`)
const tag = `v${version}`
ok(`${current} → ${version} (tag ${tag})`)

// ── 2. git state ──
step(2, 'Checking the Git repository')
let branch
try {
  branch = git('rev-parse', '--abbrev-ref', 'HEAD')
} catch {
  fail('This is not a Git repository.')
}
if (branch !== 'main') fail(`You are on "${branch}". Releases are made from main.`, 'git switch main')
if (git('status', '--porcelain')) fail('The working tree has uncommitted changes.', 'Commit or stash them first (git status).')
ok('On main, working tree clean')
try {
  git('fetch', '--quiet', '--tags', 'origin', 'main')
} catch (error) {
  fail('Could not reach origin.', String(error.stderr ?? error.message).trim())
}
const behind = Number(git('rev-list', '--count', 'HEAD..origin/main'))
if (behind > 0) fail(`main is ${behind} commit(s) behind origin/main.`, 'git pull --ff-only')
ok('Up to date with origin/main')
if (git('tag', '--list', tag)) fail(`Tag ${tag} already exists locally.`)
if (git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`)) fail(`Tag ${tag} already exists on origin.`)
ok(`Tag ${tag} is free`)

// ── 3. version bump ──
step(3, `Setting the version to ${version}`)
const undo = () => {
  try {
    git('checkout', '--', 'package.json', 'package-lock.json')
  } catch {
    // nothing to undo
  }
}
process.on('SIGINT', () => {
  undo()
  fail('Interrupted.')
})
if (!run('npm', ['version', version, '--no-git-tag-version', '--allow-same-version=false'])) {
  undo()
  fail('npm could not set the version.')
}
ok('package.json and package-lock.json updated')

// ── 4. tests ──
step(4, 'Running the tests')
const runtimeDir = join(root, 'engine-runtime', isWin ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux')
if (!existsSync(runtimeDir)) {
  undo()
  fail('The bundled engine runtime is missing, so the engine tests cannot run.', 'Run: npm run engine:prepare')
}
const suites = [
  ['Typecheck', ['run', 'typecheck']],
  ['Unit tests', ['run', 'test:unit']],
  ['Engine tests', ['run', 'engine:test']],
  ...(withE2e ? [['End-to-end test', ['run', 'test:e2e']]] : [])
]
for (const [name, npmArgs] of suites) {
  console.log(`  → ${name}`)
  // Some editors' terminals set ELECTRON_RUN_AS_NODE, which would start the app as plain Node.
  if (!run('npm', npmArgs, { drop: name === 'End-to-end test' ? ['ELECTRON_RUN_AS_NODE'] : [] })) {
    undo()
    fail(`${name} failed.`, 'Fix the failure and run the release command again.')
  }
  ok(name)
}

// ── 5. commit + tag ──
step(5, dryRun ? 'Dry run: not committing' : `Committing and tagging ${tag}`)
if (dryRun) {
  undo()
  ok('Version change undone. Everything passed — run without --dry-run to release.')
  process.exit(0)
}
const startCommit = git('rev-parse', 'HEAD')
try {
  git('add', 'package.json', 'package-lock.json')
  git('commit', '-m', `Release ${tag}`)
  git('tag', '-a', tag, '-m', `X Auto ${tag}`)
} catch (error) {
  try {
    git('tag', '-d', tag)
  } catch {
    // no tag yet
  }
  // Back to exactly where we started (only the release commit, if it was made, is dropped).
  try {
    if (git('rev-parse', 'HEAD') !== startCommit) git('reset', '--soft', startCommit)
    git('reset', '--quiet', '--', 'package.json', 'package-lock.json')
  } catch {
    // fall through to undo
  }
  undo()
  fail('Creating the release commit or tag failed.', String(error.stderr ?? error.message).trim())
}
ok(`Commit and tag ${tag} created`)

// ── 6. push ──
step(6, 'Pushing main and the tag (starts the release workflow)')
if (!run('git', ['push', '--atomic', 'origin', 'main', tag])) {
  fail(
    'Push failed — the release commit and tag exist only locally.',
    `Retry with: git push --atomic origin main ${tag}\n  Or undo with: git tag -d ${tag} && git reset --hard HEAD~1`
  )
}
let repo = ''
try {
  repo = git('remote', 'get-url', 'origin').replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/')
} catch {
  // unknown remote
}
ok(`Pushed ${tag}`)
console.log(`\nThe release workflow is building Linux, Windows and macOS now.`)
if (repo) console.log(`  Progress: ${repo}/actions/workflows/release.yml\n  Release (when finished): ${repo}/releases/tag/${tag}`)
