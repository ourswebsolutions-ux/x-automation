// Application updates: version precedence, channel safety, user consent, automation guard,
// notification de-duplication, error handling and per-platform update modes. The updater is a
// scripted fake with electron-updater's event surface; the real updater runs in the feed test.
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareVersions, describeUpdateError, isPrerelease, UpdateService } from '../../src/main/services/updates/updateService'
import { detectUpdatePlatform, readFeed, testFeedUrl } from '../../src/main/services/updates/platform'

const results: string[] = []
const check = (name: string, ok: boolean, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + String(extra).slice(0, 300) : ''}`)
const log = { debug() {}, info() {}, success() {}, warn() {}, error() {} }
const errOf = async (p: Promise<unknown>) => { try { await p; return 'none' } catch (e) { return (e as Error).message } }

// ── versions ──
check('semver: patch/minor/major', compareVersions('1.0.1', '1.0.0') > 0 && compareVersions('1.1.0', '1.0.9') > 0 && compareVersions('2.0.0', '1.99.99') > 0 && compareVersions('1.0.0', '1.0.0') === 0)
check('semver: release > its pre-releases', compareVersions('1.0.0', '1.0.0-rc.1') > 0 && compareVersions('1.0.0-rc.1', '1.0.0') < 0)
check('semver: pre-release identifiers (numeric < alpha, numeric order, longer wins)', compareVersions('1.0.0-beta.11', '1.0.0-beta.2') > 0 && compareVersions('1.0.0-alpha', '1.0.0-alpha.1') < 0 && compareVersions('1.0.0-1', '1.0.0-alpha') < 0 && compareVersions('1.0.0-rc.1', '1.0.0-beta.9') > 0)
check('semver: build metadata ignored, junk refused', compareVersions('1.0.0+abc', '1.0.0') === 0 && isPrerelease('2.0.0-beta.1') && !isPrerelease('2.0.0'))
let threw = false
try { compareVersions('1.0', '1.0.0') } catch { threw = true }
check('semver: invalid version throws', threw)

// ── errors in plain words ──
check('offline errors are quiet and plain', describeUpdateError(Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' })).quiet && !describeUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED')).message.includes('net::'))
check('integrity failures are reported, not quiet', !describeUpdateError(new Error('sha512 checksum mismatch, expected X, got Y')).quiet)
check('missing metadata / no release', describeUpdateError(new Error('Cannot find latest-linux.yml in the latest release artifacts (https://github.com/o/r/releases/download/v1/latest-linux.yml): HttpError: 404')).message.includes('No published update'))
check('messages never echo raw details', !/github\.com|HttpError|404/.test(describeUpdateError(new Error('HttpError: 404 https://github.com/x')).message))

// ── fake updater with electron-updater's events ──
class FakeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowPrerelease = true
  allowDowngrade = true
  offer: { version: string; releaseDate?: string; releaseNotes?: unknown } | null = null
  failCheck: Error | null = null
  failDownload: Error | null = null
  checks = 0
  downloads = 0
  installs: [boolean | undefined, boolean | undefined][] = []
  async checkForUpdates() {
    this.checks++
    this.emit('checking-for-update')
    if (this.failCheck) { this.emit('error', this.failCheck); throw this.failCheck }
    if (this.offer) this.emit('update-available', this.offer)
    else this.emit('update-not-available')
    return { updateInfo: this.offer }
  }
  async downloadUpdate() {
    this.downloads++
    for (const percent of [10, 55, 100]) this.emit('download-progress', { percent, transferred: percent * 1000, total: 100_000, bytesPerSecond: 5000 })
    if (this.failDownload) { this.emit('error', this.failDownload); throw this.failDownload }
    this.emit('update-downloaded', this.offer)
    return []
  }
  quitAndInstall(silent?: boolean, run?: boolean) { this.installs.push([silent, run]) }
}

const store = new Map<string, unknown>()
const settings = { get: <T>(k: string) => store.get(k) as T | undefined, set: (k: string, v: unknown) => void store.set(k, v), delete: (k: string) => void store.delete(k) }
const notices: { title: string; body?: string; tone: string }[] = []
const notifier = { notify: (n: { title: string; body?: string; tone: string }) => notices.push(n), clear() {} }
let busy: string | null = null
let stoppedForInstall = 0
const opened: string[] = []
const make = (u: FakeUpdater | null, version = '1.0.0', mode: 'in-app' | 'manual' = 'in-app') =>
  new UpdateService({
    updater: u as never, mode, modeReason: mode === 'manual' ? 'Installed from the .deb package.' : null, currentVersion: version,
    feed: { owner: 'ourswebsolutions-ux', repo: 'x-automation' }, automationBusy: () => busy,
    beforeInstall: async () => { stoppedForInstall++ }, openExternal: async (url) => { opened.push(url) },
    settings: settings as never, notifier: notifier as never, log: log as never, onChange() {}
  })

const u = new FakeUpdater()
const svc = make(u)
check('configured for consent: no auto download, no silent install on quit, no downgrade, stable channel', !u.autoDownload && !u.autoInstallOnAppQuit && !u.allowDowngrade && !u.allowPrerelease && svc.get().channel === 'stable')

let s = await svc.check(true)
check('no newer release → up to date, check time recorded', s.state === 'up-to-date' && s.available === null && s.lastCheckedAt !== null)

u.offer = { version: '1.0.1', releaseDate: '2026-10-20T10:00:00Z', releaseNotes: '<h2>Fixes</h2><ul><li>Faster sync &amp; fewer retries</li></ul><script>x</script>' }
s = await svc.check(false)
check('newer stable release → available with version, date, plain notes and release link', s.state === 'available' && s.available?.version === '1.0.1' && s.available.releaseDate === '2026-10-20T10:00:00.000Z' && s.available.releaseNotes?.includes('Faster sync & fewer retries') === true && !s.available.releaseNotes.includes('<') && s.available.releaseUrl === 'https://github.com/ourswebsolutions-ux/x-automation/releases/tag/v1.0.1', JSON.stringify(s.available))
check('… nothing downloaded without the user', u.downloads === 0)
check('… user told once', notices.filter((n) => n.title === 'X Auto 1.0.1 is available').length === 1)
await svc.check(false)
await svc.check(false)
check('… periodic re-checks don’t repeat the notice', notices.filter((n) => n.title === 'X Auto 1.0.1 is available').length === 1)

s = await svc.download()
check('download: progress shown, then downloaded', s.state === 'downloaded' && u.downloads === 1 && notices.some((n) => n.title === 'X Auto 1.0.1 is ready to install'))
check('a check while an update waits doesn’t replace it', (await svc.check(true)).state === 'downloaded' && u.checks === 4)

busy = 'A post is being published right now.'
check('install refused while automation runs (nothing stopped, nothing installed)', (await errOf(svc.install())).includes('being published') && stoppedForInstall === 0 && u.installs.length === 0 && svc.get().installBlockedReason !== null)
busy = null
await svc.install()
check('install with consent: automation stopped gracefully first, then quit-and-install (relaunch)', stoppedForInstall === 1 && u.installs.length === 1 && u.installs[0]![1] === true && svc.get().state === 'installing')

// stable build never takes a pre-release or an older/equal/garbage version
for (const version of ['1.1.0-beta.1', '0.9.0', '1.0.0', 'not-a-version']) {
  const fu = new FakeUpdater()
  fu.offer = { version }
  const st = await make(fu).check(true)
  check(`stable build ignores offer "${version}"`, st.state === 'up-to-date' && st.available === null)
}
const pu = new FakeUpdater()
pu.offer = { version: '1.1.0-beta.2' }
const pre = make(pu, '1.1.0-beta.1')
check('pre-release build: pre-release channel enabled', pu.allowPrerelease && pre.get().channel === 'prerelease')
check('… and accepts a newer pre-release', (await pre.check(true)).available?.version === '1.1.0-beta.2')

// errors: offline is quiet on automatic checks, reported on manual ones, never repeated
const eu = new FakeUpdater()
eu.failCheck = Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' })
const esvc = make(eu, '2.0.0')
const before = notices.length
s = await esvc.check(false)
check('offline automatic check: plain status, no notification', s.state === 'error' && s.error!.includes('offline') && notices.length === before)
s = await esvc.check(true)
check('offline manual check: reported once (event + rejection not doubled)', notices.length === before + 1 && s.error!.includes('offline'), JSON.stringify(notices.slice(before)))
eu.failCheck = new Error('weird internal failure')
await esvc.check(false)
await esvc.check(false)
check('a non-network failure on automatic checks is announced only once', notices.filter((n) => n.title === 'Update problem').length === 2)

// download failure (e.g. integrity) → back to "available", reported
const du = new FakeUpdater()
du.offer = { version: '3.1.0' }
du.failDownload = new Error('sha512 checksum mismatch, expected abc, got def')
const dsvc = make(du, '3.0.0')
await dsvc.check(true)
s = await dsvc.download()
check('download integrity failure: update discarded, offer kept, user told', s.state === 'available' && s.error!.includes('integrity') && notices.some((n) => n.body?.includes('integrity')))

// manual mode (.deb, ZIP, unsigned mac): detection only, release page instead of install
const mu = new FakeUpdater()
mu.offer = { version: '1.2.0' }
const msvc = make(mu, '1.0.0', 'manual')
await msvc.check(true)
check('manual mode: download refused, release page opened (github.com only)', (await errOf(msvc.download())).includes('.deb') && mu.downloads === 0 && (await msvc.openReleasePage(), opened.at(-1) === 'https://github.com/ourswebsolutions-ux/x-automation/releases/tag/v1.2.0'))
const off = make(null)
check('disabled (development): manual check explains, nothing runs', off.get().mode === 'disabled' && (await errOf(off.check(true))).length > 0)

// ── platform detection ──
const res = mkdtempSync(join(tmpdir(), 'axora-upd-'))
writeFileSync(join(res, 'app-update.yml'), 'owner: ourswebsolutions-ux\nrepo: x-automation\nprovider: github\nreleaseType: release\nupdaterCacheDirName: x-automation-updater\n')
const env = (p: Partial<Parameters<typeof detectUpdatePlatform>[0]>) => ({ isPackaged: true, platform: 'linux' as NodeJS.Platform, execPath: join(res, 'x-auto'), resourcesPath: res, productName: 'X Auto', env: {}, ...p })
check('feed read from app-update.yml', JSON.stringify(readFeed(res)) === JSON.stringify({ owner: 'ourswebsolutions-ux', repo: 'x-automation' }))
check('development build: disabled', detectUpdatePlatform(env({ isPackaged: false })).mode === 'disabled')
check('development build with a loopback test feed: enabled (test hook only)', detectUpdatePlatform(env({ isPackaged: false, env: { AXORA_TEST_UPDATE_FEED: 'http://127.0.0.1:8080/feed' } })).mode === 'in-app')
check('test feed must be loopback', testFeedUrl('https://evil.example/feed') === null && testFeedUrl('file:///etc/passwd') === null)
check('installed app ignores the test feed variable', detectUpdatePlatform(env({ env: { AXORA_TEST_UPDATE_FEED: 'http://127.0.0.1:1/x' } })).mode === 'manual')
check('Linux AppImage: in-app', detectUpdatePlatform(env({ env: { APPIMAGE: '/home/u/X-Auto.AppImage' } })).mode === 'in-app')
check('Linux .deb: manual (release page)', detectUpdatePlatform(env({})).mode === 'manual' && /deb/.test(detectUpdatePlatform(env({})).reason!))
const winDir = mkdtempSync(join(tmpdir(), 'axora-win-'))
check('Windows unpacked from the ZIP: manual', detectUpdatePlatform(env({ platform: 'win32', execPath: join(winDir, 'X Auto.exe') })).mode === 'manual')
writeFileSync(join(winDir, 'Uninstall X Auto.exe'), '')
check('Windows installed with NSIS: in-app', detectUpdatePlatform(env({ platform: 'win32', execPath: join(winDir, 'X Auto.exe') })).mode === 'in-app')
check('macOS ad-hoc/unsigned: manual', detectUpdatePlatform(env({ platform: 'darwin', codesignInfo: () => 'Signature=adhoc\nTeamIdentifier=not set' })).mode === 'manual' && detectUpdatePlatform(env({ platform: 'darwin', codesignInfo: () => null })).mode === 'manual')
check('macOS signed with a Developer ID: in-app', detectUpdatePlatform(env({ platform: 'darwin', codesignInfo: () => 'Authority=Developer ID Application: AxoraWeb (TEAM123)\nAuthority=Apple Root CA' })).mode === 'in-app')
mkdirSync(join(res, 'empty'))
check('no feed configured: disabled', detectUpdatePlatform(env({ resourcesPath: join(res, 'empty') })).mode === 'disabled')
rmSync(res, { recursive: true, force: true })
rmSync(winDir, { recursive: true, force: true })

console.log(results.join('\n'))
console.log(`\n${results.filter((x) => x.startsWith('FAIL')).length} failed of ${results.length}`)
process.exit(0)
