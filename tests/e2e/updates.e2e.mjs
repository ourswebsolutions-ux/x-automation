// Auto-update lifecycle against a local feed: the real app (development build, the loopback test feed
// hook) with the real electron-updater, driven through Settings → Security & app info → Updates.
// Covers: off by default in development, up to date, newer version found (notes, link), download
// with progress, SHA-512 verified "ready to install", tampered download rejected, a stable build
// ignoring a pre-release, and offline handling. It does NOT install (that would replace the running
// app) — installation itself is covered by the unit tests' consent/automation-guard checks only.
// Needs `npm run build` first.   node tests/e2e/updates.e2e.mjs
import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = join(dirname(fileURLToPath(import.meta.url)), '../..')
const current = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')).version
const [maj, min, pat] = current.split('-')[0].split('.').map(Number)
const next = `${maj}.${min}.${pat + 1}`
const results = []
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? ' — ' + String(extra).slice(0, 300) : ''}`)
const cleanups = []
const finish = (code) => { for (const c of cleanups) try { c() } catch {} ; setTimeout(() => process.exit(code), 500) }
process.on('uncaughtException', (e) => { console.log(results.join('\n')); console.log('CRASH', String(e?.stack ?? e).split('\n').slice(0, 6).join(' | ')); finish(1) })
process.on('unhandledRejection', (e) => { console.log(results.join('\n')); console.log('CRASH', String(e?.stack ?? e).split('\n').slice(0, 6).join(' | ')); finish(1) })
const waitFor = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return true } catch {} await new Promise((r) => setTimeout(r, 200)) } return false }

// ── the local feed (electron-updater "generic" provider layout) ──
const payload = randomBytes(24 * 1024 * 1024) // stands in for the new AppImage
const fileName = `X-Auto-${next}-linux-x86_64.AppImage`
const feed = { version: next, corrupt: false, notes: `<p>Faster scheduling &amp; clearer notices.</p>` }
const yml = () => {
  const sha512 = createHash('sha512').update(payload).digest('base64')
  return `version: ${feed.version}\nfiles:\n  - url: ${fileName}\n    sha512: ${sha512}\n    size: ${payload.length}\npath: ${fileName}\nsha512: ${sha512}\nreleaseDate: '2026-10-20T10:00:00.000Z'\nreleaseNotes: '${feed.notes}'\n`
}
const requests = []
const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname // electron-updater adds ?noCache=…
  requests.push(path)
  if (path.endsWith('latest-linux.yml')) return res.writeHead(200, { 'Content-Type': 'text/yaml' }), res.end(yml())
  if (path.endsWith(fileName)) {
    const body = feed.corrupt ? Buffer.concat([payload.subarray(0, payload.length - 4), Buffer.from('evil')]) : payload
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length })
    // Trickle the download so progress events are observable.
    let offset = 0
    const pump = () => {
      if (offset >= body.length) return res.end()
      res.write(body.subarray(offset, offset + 1024 * 1024))
      offset += 1024 * 1024
      setTimeout(pump, 150)
    }
    return pump()
  }
  res.writeHead(404).end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const feedUrl = `http://127.0.0.1:${server.address().port}/`
cleanups.push(() => server.close())

async function launch(extraEnv) {
  const home = mkdtempSync(join(tmpdir(), 'axora-upd-e2e-'))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  const env = { ...process.env, XDG_CONFIG_HOME: home, ...extraEnv }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ executablePath: electronPath, args: ['--disable-backgrounding-occluded-windows', project], env, cwd: project })
  const page = await app.firstWindow()
  await page.waitForSelector('h1', { timeout: 30000 })
  await page.evaluate(() => window.relay.preferences.update({ showDemoData: false }))
  await page.evaluate(() => (location.hash = '#/settings?section=security'))
  await page.waitForSelector('text=Updates')
  return { app, page }
}
const section = (page) => page.locator('section', { has: page.locator('h2:text-is("Updates"), h3:text-is("Updates")') }).first()

// 1. development build without the test feed: off
{
  const { app, page } = await launch({})
  const s = await page.evaluate(() => window.relay.updates.status())
  check('development build: updates off by default (never installs production updates)', s.mode === 'disabled' && /development/.test(s.modeReason ?? ''))
  check('… the panel says so', await page.getByText('Updates are turned off in development builds.').isVisible())
  await app.close()
}

// 2. with the local test feed. electron-updater only downloads for a running AppImage (it replaces
// that file on install), so a throwaway file stands in for it — nothing is installed in this test.
const fakeAppImageDir = mkdtempSync(join(tmpdir(), 'axora-fake-appimage-'))
const fakeAppImage = join(fakeAppImageDir, `X-Auto-${current}-linux-x86_64.AppImage`)
writeFileSync(fakeAppImage, 'placeholder')
cleanups.push(() => rmSync(fakeAppImageDir, { recursive: true, force: true }))
const { app, page } = await launch({ AXORA_TEST_UPDATE_FEED: feedUrl, APPIMAGE: fakeAppImage })
const status = () => page.evaluate(() => window.relay.updates.status())
check('test feed: in-app mode, stable channel, current version shown', (await status()).mode === 'in-app' && (await status()).channel === 'stable' && (await page.getByText(`X Auto ${current}`).isVisible()))

feed.version = current
await page.getByRole('button', { name: 'Check for updates' }).click()
check('same version on the feed → Up to date', await waitFor(async () => (await status()).state === 'up-to-date' && (await page.getByText('Up to date').isVisible())))

feed.version = `${maj}.${min + 1}.0-beta.1`
await page.getByRole('button', { name: 'Check for updates' }).click()
check('a pre-release on the feed is ignored by a stable build', await waitFor(async () => (await status()).state === 'up-to-date' && (await status()).available === null), JSON.stringify(await status()))

feed.version = next
await page.getByRole('button', { name: 'Check for updates' }).click()
check(`newer version ${next} detected`, await waitFor(async () => (await status()).state === 'available' && (await status()).available?.version === next), JSON.stringify(await status()))
check('… version and plain-text release notes shown', (await page.getByText(`Version ${next}`).isVisible()) && (await page.getByText('Faster scheduling & clearer notices.').isVisible()))
check('… nothing downloaded before the user asks', !requests.some((u) => u.endsWith(fileName)))

feed.corrupt = true
await page.getByRole('button', { name: 'Download update' }).click()
check('tampered download: SHA-512 check fails, update discarded, offer kept', await waitFor(async () => (await status()).state === 'available' && /integrity/.test((await status()).error ?? ''), 60000), JSON.stringify(await status()))
check('… plain message shown (panel and notice)', await page.getByText(/failed its integrity check/).first().isVisible())

feed.corrupt = false
let sawProgress = false
await page.getByRole('button', { name: 'Download update' }).click()
const downloaded = await waitFor(async () => {
  const s = await status()
  if (s.state === 'downloading' && (s.progress?.percent ?? 0) > 0 && (s.progress?.percent ?? 0) < 100) sawProgress = (await page.getByRole('progressbar', { name: 'Download progress' }).count()) > 0 || sawProgress
  return s.state === 'downloaded'
}, 90000)
check('download progress shown while downloading', sawProgress)
check('verified download → Ready to install (Restart and install offered)', downloaded && (await page.getByText('Ready to install', { exact: true }).isVisible()) && (await page.getByRole('button', { name: 'Restart and install' }).isVisible()))
check('… a check while an update waits does not replace it', (await page.evaluate(() => window.relay.updates.check())).state === 'downloaded')

await app.close()

// 3. offline (feed unreachable)
server.close()
await new Promise((r) => setTimeout(r, 200))
{
  const { app: app2, page: page2 } = await launch({ AXORA_TEST_UPDATE_FEED: feedUrl })
  await page2.getByRole('button', { name: 'Check for updates' }).click()
  const offline = await waitFor(async () => (await page2.evaluate(() => window.relay.updates.status())).state === 'error', 30000)
  const s = await page2.evaluate(() => window.relay.updates.status())
  check('offline: plain message, no crash, can retry later', offline && /offline|reach/.test(s.error ?? '') && !/ECONNREFUSED|127\.0\.0\.1/.test(s.error ?? ''), JSON.stringify(s))
  await app2.close()
}

console.log(results.join('\n'))
const failed = results.filter((r) => r.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} passed`)
finish(failed ? 1 : 0)
