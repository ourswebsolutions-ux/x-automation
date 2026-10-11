#!/usr/bin/env node
/**
 * One-command release of X Auto:
 *
 *   npm run release -- 1.0.1              full release: checks → tests → version → tag → push →
 *                                         native CI builds → GitHub Release → verification
 *   npm run release -- 1.0.1 --dry-run    every local check and test; nothing is changed or pushed
 *   npm run release -- 1.0.1 --e2e        also run the end-to-end UI test (needs Google Chrome)
 *   npm run release -- 1.0.1 --no-wait    stop after pushing (CI still builds and publishes)
 *   npm run release -- 1.0.1 --timeout=150   minutes to wait for CI (default 120)
 *
 * Re-running the same command after a failure is safe: an existing tag is never moved or
 * deleted. If the tag already exists the command resumes — pushes a tag that never reached
 * GitHub, waits for a running build, (re)starts the release workflow for that tag, or just
 * verifies a release that is already complete.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareVersions, expectedAssets, githubToken, parseVersion, verifyRemoteRelease } from './release-assets.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const option = (name, fallback) => Number(args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback)
const dryRun = flag('dry-run')
const withE2e = flag('e2e')
const noWait = flag('no-wait')
const timeoutMin = option('timeout', 120)
const input = args.find((a) => !a.startsWith('--'))
const isWin = process.platform === 'win32'
const WORKFLOW = 'release.yml'

// ── output ──
const color = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text)
let stepNo = 0
const step = (text) => console.log(`\n${paint(1, `[${++stepNo}] ${text}`)}`)
const ok = (text) => console.log(`  ${paint(32, '✓')} ${text}`)
const info = (text) => console.log(`  ${paint(36, '•')} ${text}`)
const warn = (text) => console.log(`  ${paint(33, '!')} ${text}`)
class ReleaseError extends Error {
  constructor(message, recovery = '') {
    super(message)
    this.recovery = recovery
  }
}
const fail = (message, recovery = '') => {
  throw new ReleaseError(message, recovery)
}

// ── processes ──
const run = (cmd, cmdArgs, opts = {}) => {
  const r = spawnSync(cmd, cmdArgs, { cwd: root, encoding: 'utf8', shell: isWin && cmd === 'npm', ...opts })
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }
}
const git = (...a) => {
  const r = run('git', a)
  if (r.status !== 0) throw Object.assign(new Error(r.stderr.trim() || `git ${a[0]} failed`), { stderr: r.stderr })
  return r.stdout.trim()
}
const tryGit = (...a) => {
  try {
    return git(...a)
  } catch {
    return null
  }
}
const gh = (a, { json = false } = {}) => {
  const r = run('gh', a)
  if (r.error?.code === 'ENOENT') fail('The GitHub CLI (gh) is not installed.', 'Install it from https://cli.github.com, then run: gh auth login && gh auth setup-git')
  if (r.status !== 0) throw Object.assign(new Error(r.stderr.trim() || r.stdout.trim() || `gh ${a[0]} failed`), { stderr: r.stderr })
  return json ? JSON.parse(r.stdout || 'null') : r.stdout.trim()
}
const tryGh = (a, opts) => {
  try {
    return gh(a, opts)
  } catch (error) {
    if (error instanceof ReleaseError) throw error
    return null
  }
}
/** Interactive steps (tests, push) stream their output. */
const runVisible = (cmd, cmdArgs, { drop = [] } = {}) => {
  const env = { ...process.env }
  for (const key of drop) delete env[key]
  return spawnSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit', shell: isWin && cmd === 'npm', env }).status === 0
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── version files: exact snapshot / restore (never `git checkout`, which would drop user edits) ──
const VERSION_FILES = ['package.json', 'package-lock.json']
let snapshot = null
const takeSnapshot = () => (snapshot = Object.fromEntries(VERSION_FILES.map((f) => [f, readFileSync(join(root, f))])))
const restoreSnapshot = () => {
  if (!snapshot) return
  for (const [f, bytes] of Object.entries(snapshot)) writeFileSync(join(root, f), bytes)
  snapshot = null
}
let phase = 'checks' // checks → bumped → committed → pushed
let interrupted = false
const onSignal = (signal) => {
  if (interrupted) process.exit(130)
  interrupted = true
  console.log(`\n${paint(33, `Interrupted (${signal}).`)}`)
  if (phase === 'bumped') {
    restoreSnapshot()
    console.log('The version files were restored exactly. Nothing was committed or pushed.')
  } else if (phase === 'committed') {
    console.log('The release commit and tag exist only locally. Run the same command again to push them and continue.')
  } else if (phase === 'pushed') {
    console.log('The tag is pushed and GitHub Actions keeps building. Run the same command again to wait for and verify the release.')
  } else {
    console.log('Nothing was changed.')
  }
  process.exit(130)
}
process.on('SIGINT', () => onSignal('SIGINT'))
process.on('SIGTERM', () => onSignal('SIGTERM'))

// ── GitHub helpers ──
function repoSlug() {
  const url = git('remote', 'get-url', 'origin')
  const m = /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url)
  if (!m) fail(`origin (${url}) is not a GitHub repository.`)
  return `${m[1]}/${m[2]}`
}

function findRun(repo, { tag, sha, event, after }) {
  const runs =
    tryGh(['run', 'list', '--repo', repo, '--workflow', WORKFLOW, '--limit', '30', '--json', 'databaseId,headSha,headBranch,event,status,conclusion,createdAt,url,displayTitle'], { json: true }) ?? []
  return (
    runs
      .filter((r) => r.headSha === sha && (!event || r.event === event) && (event !== 'push' || r.headBranch === tag) && (!after || Date.parse(r.createdAt) >= after - 60_000))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null
  )
}

async function waitForRun(repo, runRef) {
  const started = Date.now()
  const deadline = started + timeoutMin * 60_000
  let last = ''
  let queuedSince = null
  info(`Workflow run: ${runRef.url}`)
  for (;;) {
    const view = tryGh(['run', 'view', String(runRef.databaseId), '--repo', repo, '--json', 'status,conclusion,jobs,url'], { json: true })
    if (view) {
      const jobs = (view.jobs ?? []).map((j) => `${j.name}: ${j.status === 'completed' ? j.conclusion : j.status}`).join(' | ')
      if (jobs !== last) {
        info(`${new Date().toLocaleTimeString()}  ${jobs || view.status}`)
        last = jobs
      }
      if (view.status === 'completed') return view
      const anyRunning = (view.jobs ?? []).some((j) => j.status === 'in_progress' || j.status === 'completed')
      if (!anyRunning) {
        queuedSince ??= Date.now()
        if (Date.now() - queuedSince > 30 * 60_000) {
          fail('The workflow has been waiting for a runner for over 30 minutes.', `Check ${view.url} (Actions minutes, runner availability). Re-run this command later to keep waiting.`)
        }
      } else queuedSince = null
    }
    if (Date.now() > deadline) fail(`Timed out after ${timeoutMin} minutes waiting for the workflow.`, `It may still finish: ${runRef.url}\n  Re-run the same command to keep waiting and verify, or pass --timeout=180.`)
    await sleep(20_000)
  }
}

function explainFailedRun(repo, view) {
  const failed = (view.jobs ?? []).filter((j) => j.conclusion && !['success', 'skipped'].includes(j.conclusion))
  console.log(`\n${paint(31, 'Failed jobs:')}`)
  for (const j of failed) {
    console.log(`  • ${j.name}: ${j.conclusion}`)
    for (const s of (j.steps ?? []).filter((s) => s.conclusion === 'failure')) console.log(`      step "${s.name}" failed`)
  }
  const log = run('gh', ['run', 'view', String(view.databaseId ?? ''), '--repo', repo, '--log-failed'])
  if (log.status === 0 && log.stdout.trim()) {
    console.log(`\n${paint(2, 'Last lines of the failed steps:')}`)
    console.log(
      log.stdout
        .trim()
        .split('\n')
        .slice(-40)
        .map((l) => `  ${l}`)
        .join('\n')
    )
  }
}

async function verifyAndReport(repo, version) {
  step('Verifying the published release')
  const token = githubToken((c, a) => run(c, a))
  const result = await verifyRemoteRelease({ repo, version, token })
  if (result.problems.length) {
    for (const p of result.problems) warn(p)
    fail(`The release v${version} is not complete or not consistent (${result.problems.length} problem(s)).`, `Re-run the same command to rebuild and repair it (rerun-safe): npm run release -- ${version}`)
  }
  ok(`Release published: ${result.release.url}`)
  console.log(`\n${paint(1, 'Downloads')}`)
  for (const a of result.assets) console.log(`  ${a.platform.padEnd(8)} ${a.arch.padEnd(22)} ${a.url}`)
  console.log(`\n${paint(1, 'Auto-update')}`)
  if (result.anonymousFeed) ok('Update feed is publicly readable — installed apps will discover this release.')
  else
    warn(
      'The update feed is NOT readable without credentials (the repository is private). Installed apps cannot discover updates until the releases are public — see docs/release.md "Auto-update feed".'
    )
  return result
}

// ── main ──
async function main() {
  const startedAt = Date.now()

  // 1. version
  step('Checking the version')
  if (!input) fail('No version given.', 'Usage: npm run release -- 1.0.1   (add --dry-run to test without changing anything)')
  const version = input.replace(/^v/, '')
  const parsed = parseVersion(version)
  if (!parsed) fail(`"${input}" is not a valid version.`, 'Use MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-beta.N, e.g. 1.0.1 or 1.1.0-beta.1')
  if (parsed.pre.length && /^\d+$/.test(parsed.pre[0])) fail(`Pre-release "${version}" must start with a name (e.g. ${parsed.major}.${parsed.minor}.${parsed.patch}-beta.${parsed.pre[0]}).`, 'The name is the update channel; a number alone would mix it with stable updates.')
  const tag = `v${version}`
  const current = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  ok(`Requested ${version} (${parsed.pre.length ? `pre-release channel "${parsed.pre[0]}"` : 'stable'}), package.json is ${current}`)

  // 2. git
  step('Checking the Git repository')
  if (!tryGit('rev-parse', '--git-dir')) fail('This is not a Git repository.')
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  if (branch !== 'main') fail(`You are on "${branch}". Releases are made from main.`, 'git switch main')
  const dirty = git('status', '--porcelain')
  if (dirty) fail('The working tree has uncommitted changes:\n' + dirty.split('\n').slice(0, 10).map((l) => `    ${l}`).join('\n'), 'Commit or stash them first — the release must be built from committed code.')
  ok('On main, working tree clean')

  // 3. GitHub access (before anything irreversible)
  step('Checking GitHub access')
  const auth = run('gh', ['auth', 'status', '--hostname', 'github.com'])
  const authProblem =
    auth.error?.code === 'ENOENT'
      ? ['The GitHub CLI (gh) is not installed.', 'Install it from https://cli.github.com, then run: gh auth login && gh auth setup-git']
      : auth.status !== 0
        ? ['The GitHub CLI is not logged in.', 'Run: gh auth login   (choose HTTPS and "Login with a web browser"), then: gh auth setup-git']
        : null
  if (authProblem && dryRun) {
    // A dry run still exercises every local check; the real run needs this fixed first.
    warn(`${authProblem[0]} A real release would stop here. ${authProblem[1]}`)
    warn('Continuing the dry run with local checks only (remote tags, releases and permissions not inspected).')
    return localDryRun({ version, tag, current })
  }
  if (authProblem) fail(authProblem[0], authProblem[1])
  ok('GitHub CLI logged in')
  const repo = repoSlug()
  const repoInfo = tryGh(['repo', 'view', repo, '--json', 'nameWithOwner,viewerPermission,isPrivate,isArchived,defaultBranchRef'], { json: true })
  if (!repoInfo) fail(`Cannot read ${repo} with the current GitHub login.`, 'Check that this account has access to the repository: gh auth status')
  if (repoInfo.isArchived) fail(`${repo} is archived.`)
  if (!['ADMIN', 'MAINTAIN', 'WRITE'].includes(repoInfo.viewerPermission)) fail(`Your GitHub account has ${repoInfo.viewerPermission} access to ${repo}; pushing a release needs write access.`)
  ok(`${repoInfo.nameWithOwner}: ${repoInfo.viewerPermission.toLowerCase()} access, ${repoInfo.isPrivate ? 'private' : 'public'}`)
  if (repoInfo.isPrivate) warn('The repository is private: installers will be published, but installed apps can only read the update feed from public releases (docs/release.md).')
  const actions = tryGh(['api', `repos/${repo}/actions/permissions`], { json: true })
  if (actions && actions.enabled === false) fail('GitHub Actions is disabled for this repository.', `Enable it: https://github.com/${repo}/settings/actions`)
  if (!tryGh(['workflow', 'view', WORKFLOW, '--repo', repo])) fail(`The ${WORKFLOW} workflow is not on GitHub yet.`, 'Push main first (git push origin main), then run the release again.')
  ok('Actions enabled, release workflow present')
  // Fetch main only: remote tags are inspected read-only below and never overwrite local tags.
  const fetched = run('git', ['fetch', '--quiet', '--no-tags', 'origin', 'main'])
  if (fetched.status !== 0) fail('Could not fetch from origin.', `${fetched.stderr.trim()}\n  Run: gh auth setup-git   (lets git use the GitHub CLI login)`)
  const behind = Number(git('rev-list', '--count', 'HEAD..origin/main'))
  if (behind > 0) fail(`main is ${behind} commit(s) behind origin/main.`, 'git pull --ff-only')
  ok('Up to date with origin/main')

  // 4. existing tag / release
  step(`Inspecting ${tag}`)
  const localTag = tryGit('rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`)
  const remoteLine = git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`)
  const remoteTag = remoteLine
    ? (/^(\w+)\s+refs\/tags\/[^\s]+\^\{\}$/m.exec(remoteLine)?.[1] ?? /^(\w+)\s+refs\/tags\/\S+$/m.exec(remoteLine)?.[1])
    : null
  if (remoteTag && !tryGit('cat-file', '-e', `${remoteTag}^{commit}`)) run('git', ['fetch', '--quiet', '--no-tags', 'origin', `refs/tags/${tag}`])
  const release = tryGh(['release', 'view', tag, '--repo', repo, '--json', 'tagName,isDraft,isPrerelease,url,assets'], { json: true })

  if (!localTag && !remoteTag) {
    if (release) fail(`A GitHub Release ${tag} exists but its tag does not.`, `Inspect it at ${release.url}; delete that orphaned release by hand only if you are sure, or choose another version.`)
    if (compareVersions(version, current) <= 0) fail(`${version} is not newer than the current version ${current}.`, `Choose a higher version, e.g. npm run release -- ${parsed.major}.${parsed.minor}.${parsed.patch + 1}`)
    ok(`${tag} is new`)
    return newRelease({ repo, version, tag, startedAt })
  }
  return resumeRelease({ repo, version, tag, localTag, remoteTag, release, startedAt })
}

async function runTests() {
  step('Running the mandatory checks')
  if (process.env.AXORA_RELEASE_SELFTEST === '1') {
    // Test hook for tests/release (exercises version handling quickly); refused outside --dry-run.
    if (!dryRun) fail('AXORA_RELEASE_SELFTEST is only allowed with --dry-run.')
    warn('Self-test mode: test suites skipped (dry run only).')
    return
  }
  const runtimeDir = join(root, 'engine-runtime', isWin ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux')
  if (!existsSync(runtimeDir)) fail('The bundled engine runtime is missing, so the engine tests cannot run.', 'Run: npm run engine:prepare')
  const suites = [
    ['Typecheck', ['run', 'typecheck']],
    ['Unit tests', ['run', 'test:unit']],
    ['Release tooling tests', ['run', 'test:release']],
    ['Engine tests', ['run', 'engine:test']],
    ...(withE2e ? [['End-to-end test', ['run', 'test:e2e']]] : [])
  ]
  for (const [name, npmArgs] of suites) {
    info(`${name} …`)
    // Some editors' terminals set ELECTRON_RUN_AS_NODE, which would start the app as plain Node.
    if (!runVisible('npm', npmArgs, { drop: ['ELECTRON_RUN_AS_NODE'] })) fail(`${name} failed.`, 'Fix the failure, commit, and run the release command again. Nothing was changed.')
    ok(name)
  }
}

async function newRelease({ repo, version, tag, startedAt }) {
  await runTests()

  step(`Setting the version to ${version}`)
  takeSnapshot()
  phase = 'bumped'
  const bump = run('npm', ['version', version, '--no-git-tag-version', '--allow-same-version=false'])
  const pkgOk = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version === version
  const lockOk = (() => {
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
    return lock.version === version && lock.packages?.['']?.version === version
  })()
  if (bump.status !== 0 || !pkgOk || !lockOk) {
    restoreSnapshot()
    phase = 'checks'
    fail('Could not set the version consistently in package.json and package-lock.json.', bump.stderr.trim())
  }
  ok('package.json and package-lock.json updated')

  if (dryRun) {
    restoreSnapshot()
    phase = 'checks'
    const clean = git('status', '--porcelain') === ''
    step('Dry run complete')
    ok(`Version files restored byte-for-byte${clean ? ' (working tree clean)' : ''}. Nothing committed, tagged or pushed.`)
    const { all } = expectedAssets(version)
    info(`A real run would publish ${all.length} files: ${all.map((a) => a.name).join(', ')}`)
    return
  }

  step(`Committing and tagging ${tag}`)
  const startCommit = git('rev-parse', 'HEAD')
  try {
    git('add', '--', ...VERSION_FILES)
    git('commit', '-m', `Release ${tag}`, '--', ...VERSION_FILES)
    git('tag', '-a', tag, '-m', `X Auto ${tag}`)
  } catch (error) {
    // Undo only what this command did: our tag, our commit (soft), and the version change.
    tryGit('tag', '-d', tag)
    if (git('rev-parse', 'HEAD') !== startCommit) tryGit('reset', '--soft', startCommit)
    tryGit('reset', '--quiet', '--', ...VERSION_FILES)
    restoreSnapshot()
    phase = 'checks'
    fail('Creating the release commit or tag failed.', String(error.stderr ?? error.message).trim())
  }
  snapshot = null
  phase = 'committed'
  ok(`Commit ${git('rev-parse', '--short', 'HEAD')} and annotated tag ${tag}`)

  await pushAndFollow({ repo, version, tag, startedAt })
}

async function pushAndFollow({ repo, version, tag, startedAt }) {
  step('Pushing main and the tag together (starts the release workflow)')
  const pushedAt = Date.now()
  if (!runVisible('git', ['push', '--atomic', 'origin', 'main', tag])) {
    fail('The push failed — the release commit and tag exist only locally (nothing on GitHub changed).', 'Fix access (gh auth setup-git) or sync main, then run the same command again: it pushes the existing tag and continues.')
  }
  phase = 'pushed'
  ok(`Pushed ${tag}`)
  if (noWait) {
    info(`Not waiting (--no-wait). Follow: https://github.com/${repo}/actions/workflows/${WORKFLOW}`)
    info(`Then verify with: npm run release -- ${version}`)
    return
  }
  const sha = git('rev-parse', `${tag}^{commit}`)
  await followRun({ repo, version, tag, sha, event: 'push', after: pushedAt, startedAt })
}

async function followRun({ repo, version, tag, sha, event, after, startedAt }) {
  step('Waiting for the native builds (Linux, Windows, macOS Intel + Apple silicon)')
  let runRef = null
  for (let i = 0; i < 18 && !runRef; i++) {
    runRef = findRun(repo, { tag, sha, event, after })
    if (!runRef) await sleep(10_000)
  }
  if (!runRef) fail(`No ${WORKFLOW} run started for ${tag} within 3 minutes.`, `Check https://github.com/${repo}/actions. Re-running this command starts the workflow for ${tag} if it never ran.`)
  const view = await waitForRun(repo, runRef)
  if (view.conclusion !== 'success') {
    explainFailedRun(repo, { ...view, databaseId: runRef.databaseId })
    // The publish job may have published before a later step failed: check what is really on GitHub.
    const published = tryGh(['release', 'view', tag, '--repo', repo, '--json', 'isDraft'], { json: true })
    if (published && !published.isDraft) {
      warn('The workflow reported a failure, but the release is published — verifying it from here')
      await verifyAndReport(repo, version)
      console.log(`\n${paint(32, `X Auto ${tag} is released.`)} (the workflow's own final check failed; the release passed verification here)`)
      return
    }
    fail(
      `The release workflow ${view.conclusion} — no release was published (it is only published after every platform succeeds).`,
      `If it was a temporary problem: gh run rerun ${runRef.databaseId} --failed --repo ${repo}   then: npm run release -- ${version}\n  If the code needs a fix: commit it and release the next version (the tag ${tag} stays as it is).`
    )
  }
  ok(`Workflow succeeded in ${Math.round((Date.now() - after) / 60_000)} min`)
  await verifyAndReport(repo, version)
  console.log(`\n${paint(32, `X Auto ${tag} is released.`)} (${Math.round((Date.now() - startedAt) / 60_000)} min total)`)
}

async function resumeRelease({ repo, version, tag, localTag, remoteTag, release, startedAt }) {
  // Tag exists: never move or delete it. Work out what is missing and finish only that.
  if (localTag && remoteTag && localTag !== remoteTag) {
    fail(`The local tag ${tag} (${localTag.slice(0, 7)}) differs from the one on GitHub (${remoteTag.slice(0, 7)}).`, `Inspect both; nothing was changed. To use GitHub's: git tag -d ${tag} && git fetch --tags`)
  }
  const sha = remoteTag ?? localTag
  const tagVersion = (() => {
    try {
      return JSON.parse(git('show', `${sha}:package.json`)).version
    } catch {
      return null
    }
  })()
  if (tagVersion !== version) fail(`${tag} points to a commit whose package.json version is ${tagVersion}.`, 'That tag was not made by this release process. Choose a new version.')
  // Releases need the pipeline (update metadata, artifact names) that this command validates.
  if (!tryGit('cat-file', '-e', `${sha}:scripts/release-assets.mjs`)) {
    fail(
      `${tag} was tagged from code that predates the current release pipeline (no auto-update metadata, different installer names), so it cannot be rebuilt into a complete release without changing what that tag means.`,
      `Leave ${tag} as it is and release the next version: npm run release -- ${bumpPatch(version)}`
    )
  }
  if (dryRun) {
    step('Dry run')
    ok(`${tag} already exists (${remoteTag ? 'on GitHub' : 'local only'}); a real run would resume it. Nothing changed.`)
    return
  }

  if (!remoteTag) {
    // Our own release commit + tag never reached GitHub (e.g. the push failed): push it now.
    const head = git('rev-parse', 'HEAD')
    if (localTag !== head) fail(`The local tag ${tag} is not on the current commit and was never pushed.`, `Inspect with: git log --oneline ${tag} -1   (nothing was changed)`)
    info(`${tag} exists only locally — pushing it`)
    phase = 'committed'
    return pushAndFollow({ repo, version, tag, startedAt })
  }

  if (release && !release.isDraft) {
    info('A published release exists — verifying it')
    try {
      await verifyAndReport(repo, version)
      console.log(`\n${paint(32, `X Auto ${tag} is already released and complete.`)}`)
      return
    } catch (error) {
      if (!(error instanceof ReleaseError)) throw error
      warn('The published release is incomplete — rebuilding and repairing it')
    }
  }

  // Wait for a build that is still running, otherwise (re)start the workflow for this tag.
  const existing = findRun(repo, { tag, sha })
  if (existing && existing.status !== 'completed') {
    info(`A release run for ${tag} is in progress — waiting for it`)
    const view = await waitForRun(repo, existing)
    if (view.conclusion === 'success') {
      await verifyAndReport(repo, version)
      console.log(`\n${paint(32, `X Auto ${tag} is released.`)}`)
      return
    }
    explainFailedRun(repo, { ...view, databaseId: existing.databaseId })
    warn('That run failed; starting a fresh run for the same tag')
  }
  step(`Starting the release workflow for the existing tag ${tag}`)
  const dispatchedAt = Date.now()
  gh(['workflow', 'run', WORKFLOW, '--repo', repo, '--ref', tag, '-f', `tag=${tag}`])
  ok('Workflow started')
  phase = 'pushed'
  await followRun({ repo, version, tag, sha, event: 'workflow_dispatch', after: dispatchedAt, startedAt })
}

/** Dry run without GitHub access: local tag check, tests, version bump and exact restore. */
async function localDryRun({ version, tag, current }) {
  if (tryGit('rev-parse', '--verify', '--quiet', `refs/tags/${tag}`)) {
    warn(`${tag} already exists locally — a real run would inspect GitHub and resume or stop safely.`)
    return
  }
  if (compareVersions(version, current) <= 0) fail(`${version} is not newer than the current version ${current}.`)
  return newRelease({ repo: null, version, tag, startedAt: Date.now() })
}

function bumpPatch(v) {
  const p = parseVersion(v)
  return `${p.major}.${p.minor}.${p.patch + 1}`
}

main().catch((error) => {
  if (phase === 'bumped') restoreSnapshot()
  if (error instanceof ReleaseError) {
    console.error(`\n${paint(31, `✗ ${error.message}`)}${error.recovery ? `\n  ${error.recovery}` : ''}`)
    console.error(
      phase === 'checks' || phase === 'bumped'
        ? '\nNothing was committed, tagged or pushed.'
        : phase === 'committed'
          ? '\nThe release commit and tag exist locally only. Run the same command again to continue.'
          : '\nThe tag is on GitHub. Run the same command again to resume (it never moves or deletes the tag).'
    )
  } else {
    console.error(`\n${paint(31, '✗ Unexpected error:')} ${error?.stack ?? error}`)
  }
  process.exit(1)
})
