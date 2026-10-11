import type { AvailableUpdate, UpdateMode, UpdateStatus } from '@shared/types/updates'
import type { SettingsRepository } from '../database/repositories'
import { ConflictError, ValidationError } from '../errors'
import type { ScopedLogger } from '../logging/logger'
import type { Notifier } from '../notifications/notifier'

/** The parts of electron-updater's AppUpdater this service uses (so it can be tested with a fake). */
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  on(event: 'checking-for-update' | 'update-not-available', listener: () => void): unknown
  on(event: 'update-available' | 'update-downloaded', listener: (info: { version: string; releaseDate?: string; releaseNotes?: unknown }) => void): unknown
  on(event: 'download-progress', listener: (p: { percent: number; transferred: number; total: number; bytesPerSecond: number }) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

interface Deps {
  updater: UpdaterLike | null
  mode: UpdateMode
  modeReason: string | null
  currentVersion: string
  /** Where releases are published (from app-update.yml); used only to build github.com release links. */
  feed: { owner: string; repo: string } | null
  /** A reason when installing now would interrupt automation, otherwise null. */
  automationBusy: () => string | null
  /** Stops scheduling, the queue and the engine gracefully before the app quits to install. */
  beforeInstall: () => Promise<void>
  openExternal: (url: string) => Promise<void>
  settings: SettingsRepository
  notifier: Notifier
  log: ScopedLogger
  onChange: (status: UpdateStatus) => void
  now?: () => Date
  checkIntervalMs?: number
  startupDelayMs?: number
}

const SETTINGS_KEY = 'updates.state'
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/
const GITHUB_SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/

/** Semantic-version comparison (SemVer 2.0 precedence, build metadata ignored). > 0 when a is newer. */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a)
  const pb = SEMVER.exec(b)
  if (!pa || !pb) throw new ValidationError(`Not a valid version: ${!pa ? a : b}`)
  for (let i = 1; i <= 3; i++) if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) - Number(pb[i])
  if (!pa[4] && !pb[4]) return 0
  if (!pa[4]) return 1
  if (!pb[4]) return -1
  const ia = pa[4].split('.')
  const ib = pb[4].split('.')
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    if (ia[i] === undefined) return -1
    if (ib[i] === undefined) return 1
    const na = /^\d+$/.test(ia[i]!)
    const nb = /^\d+$/.test(ib[i]!)
    if (na && nb && Number(ia[i]) !== Number(ib[i])) return Number(ia[i]) - Number(ib[i])
    if (na !== nb) return na ? -1 : 1
    if (!na && ia[i] !== ib[i]) return ia[i]! < ib[i]! ? -1 : 1
  }
  return 0
}

export const isPrerelease = (version: string) => Boolean(SEMVER.exec(version)?.[4])

/** Release notes arrive as HTML (GitHub) or a list of notes; keep readable plain text only. */
function plainNotes(notes: unknown): string | null {
  const text = Array.isArray(notes)
    ? notes.map((n) => (n && typeof n === 'object' && 'note' in n ? String((n as { note: unknown }).note ?? '') : '')).join('\n')
    : typeof notes === 'string'
      ? notes
      : ''
  const cleaned = text
    .replace(/<\s*(br|\/p|\/li|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return cleaned ? cleaned.slice(0, 4000) : null
}

/** Updater errors in plain words; `quiet` = expected while offline, not worth a notification on automatic checks. */
export function describeUpdateError(error: unknown): { message: string; quiet: boolean } {
  const raw = error instanceof Error ? `${error.name} ${error.message} ${(error as { code?: string }).code ?? ''}` : String(error)
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|net::ERR_|socket hang up|getaddrinfo/i.test(raw)) {
    return { message: 'Couldn’t reach the update server. You may be offline — X Auto will try again later.', quiet: true }
  }
  if (/sha512 checksum mismatch|checksum mismatch|integrity/i.test(raw)) {
    return { message: 'The downloaded update failed its integrity check and was discarded. Try again later.', quiet: false }
  }
  if (/\b404\b|Cannot find latest|No published versions|Cannot find .*\.yml|latest.*\.yml/i.test(raw)) {
    return { message: 'No published update was found on the release page yet.', quiet: true }
  }
  if (/\b(401|403)\b|authentication|rate limit/i.test(raw)) {
    return { message: 'The release page couldn’t be read (access denied or rate-limited). Try again later.', quiet: true }
  }
  if (/code signature|signature/i.test(raw)) {
    return { message: 'The update couldn’t be verified (code signature). Download it from the release page instead.', quiet: false }
  }
  return { message: 'Checking for updates didn’t work this time. X Auto will try again later.', quiet: false }
}

/**
 * Application updates from GitHub Releases. Checks at start-up and every few hours; never
 * downloads or installs without the user's go-ahead, never restarts while automation is
 * running, and tells the user about each new version (and each distinct failure) only once.
 * Updates replace the program files only — the database, settings, accounts, proxies,
 * drafts, schedules and images live in the user-data folder and are left untouched.
 */
export class UpdateService {
  private status: UpdateStatus
  private timer: NodeJS.Timeout | null = null
  private startTimer: NodeJS.Timeout | null = null
  private manualCheck = false
  private lastProgressAt = 0

  constructor(private readonly deps: Deps) {
    const stored = deps.settings.get<{ lastCheckedAt?: string }>(SETTINGS_KEY) ?? {}
    this.status = {
      mode: deps.updater ? deps.mode : 'disabled',
      modeReason: deps.updater ? deps.modeReason : (deps.modeReason ?? 'Updates are turned off in this build.'),
      currentVersion: deps.currentVersion,
      channel: isPrerelease(deps.currentVersion) ? 'prerelease' : 'stable',
      state: 'idle',
      available: null,
      progress: null,
      lastCheckedAt: stored.lastCheckedAt ?? null,
      error: null,
      installBlockedReason: null
    }
    const u = deps.updater
    if (!u) return
    u.autoDownload = false // the user decides
    u.autoInstallOnAppQuit = false // installed only on an explicit "Restart and install"
    u.allowPrerelease = this.status.channel === 'prerelease'
    u.allowDowngrade = false
    u.on('checking-for-update', () => this.set({ state: 'checking', error: null }))
    u.on('update-not-available', () => this.finishCheck({ state: 'up-to-date', available: null }))
    u.on('update-available', (info) => this.onAvailable(info))
    u.on('download-progress', (p) => {
      const now = Date.now()
      if (now - this.lastProgressAt < 250 && p.percent < 100) return
      this.lastProgressAt = now
      this.set({ state: 'downloading', progress: { percent: Math.round(p.percent * 10) / 10, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond } })
    })
    u.on('update-downloaded', (info) => {
      if (!this.status.available || info.version !== this.status.available.version) return
      this.set({ state: 'downloaded', progress: null, error: null })
      this.notifyOnce(`downloaded:${info.version}`, { tone: 'success', title: `X Auto ${info.version} is ready to install`, body: 'Restart X Auto when it suits you — your data stays as it is.' })
    })
    u.on('error', (error) => this.onError(error))
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  get(): UpdateStatus {
    return { ...this.status, available: this.status.available ? { ...this.status.available } : null, progress: this.status.progress ? { ...this.status.progress } : null }
  }

  start(): void {
    if (!this.deps.updater || this.timer) return
    this.startTimer = setTimeout(() => void this.check(false), this.deps.startupDelayMs ?? 20_000)
    this.timer = setInterval(() => void this.check(false), this.deps.checkIntervalMs ?? 6 * 60 * 60 * 1000)
    this.startTimer.unref?.()
    this.timer.unref?.()
  }

  stop(): void {
    if (this.startTimer) clearTimeout(this.startTimer)
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.startTimer = null
  }

  /** Looks for a newer release. Manual checks report problems; automatic ones stay quiet when offline. */
  async check(manual = true): Promise<UpdateStatus> {
    const u = this.deps.updater
    if (!u) {
      if (manual) throw new ConflictError(this.status.modeReason ?? 'Updates are turned off in this build.')
      return this.get()
    }
    // Never interrupt a download or replace a downloaded update with a new check.
    if (['checking', 'downloading', 'downloaded', 'installing'].includes(this.status.state)) return this.get()
    this.manualCheck = manual
    this.set({ state: 'checking', error: null })
    try {
      await u.checkForUpdates()
      if (this.status.state === 'checking') this.finishCheck({ state: 'up-to-date', available: null })
    } catch (error) {
      // electron-updater reports a failure both as an 'error' event and as a rejection: handle it once.
      if (this.get().state === 'checking') this.onError(error)
    }
    return this.get()
  }

  /** Downloads the available update (in-app mode). Progress arrives as status changes. */
  async download(): Promise<UpdateStatus> {
    const u = this.deps.updater
    if (!u || this.status.mode !== 'in-app') throw new ConflictError(this.status.modeReason ?? 'This copy of X Auto is updated from the release page.')
    if (this.status.state === 'downloading' || this.status.state === 'downloaded') return this.get()
    if (this.status.state !== 'available' || !this.status.available) throw new ConflictError('There is no update to download. Check for updates first.')
    this.set({ state: 'downloading', progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 }, error: null })
    this.manualCheck = true // the user asked for this download, so a failure is reported
    try {
      await u.downloadUpdate()
    } catch (error) {
      if (this.get().state === 'downloading') this.onError(error) // not already reported by the 'error' event
    }
    return this.get()
  }

  /** Restarts into the downloaded update — refused while automation is running. */
  async install(): Promise<void> {
    const u = this.deps.updater
    if (!u || this.status.state !== 'downloaded') throw new ConflictError('No downloaded update is waiting to be installed.')
    const busy = this.deps.automationBusy()
    if (busy) {
      this.set({ installBlockedReason: busy })
      throw new ConflictError(busy)
    }
    this.set({ state: 'installing', installBlockedReason: null })
    this.deps.log.info(`Installing update ${this.status.available?.version}`)
    try {
      await this.deps.beforeInstall()
      u.quitAndInstall(false, true)
    } catch (error) {
      this.set({ state: 'downloaded' })
      throw error
    }
  }

  /** Opens the GitHub Release page of the available version (or the releases list). */
  async openReleasePage(): Promise<void> {
    const url = this.status.available?.releaseUrl ?? this.releasesUrl()
    if (!url) throw new ConflictError('No release page is configured for this build.')
    await this.deps.openExternal(url)
  }

  // ── internals ────────────────────────────────────────────────────────────

  private releasesUrl(version?: string): string | null {
    const feed = this.deps.feed
    if (!feed || !GITHUB_SEGMENT.test(feed.owner) || !GITHUB_SEGMENT.test(feed.repo)) return null
    const base = `https://github.com/${encodeURIComponent(feed.owner)}/${encodeURIComponent(feed.repo)}/releases`
    return version ? `${base}/tag/v${encodeURIComponent(version)}` : base
  }

  private onAvailable(info: { version: string; releaseDate?: string; releaseNotes?: unknown }): void {
    const version = String(info.version ?? '')
    // Trust only well-formed, newer versions; a stable build never takes a pre-release.
    let newer = false
    try {
      newer = compareVersions(version, this.status.currentVersion) > 0
    } catch {
      newer = false
    }
    if (!newer || (this.status.channel === 'stable' && isPrerelease(version))) {
      this.deps.log.warn('Ignored an update offer that is not a newer release on this channel', { version })
      this.finishCheck({ state: 'up-to-date', available: null })
      return
    }
    const available: AvailableUpdate = {
      version,
      releaseDate: info.releaseDate && !Number.isNaN(Date.parse(info.releaseDate)) ? new Date(info.releaseDate).toISOString() : null,
      releaseNotes: plainNotes(info.releaseNotes),
      releaseUrl: this.releasesUrl(version)
    }
    this.finishCheck({ state: 'available', available })
    this.notifyOnce(`available:${version}`, {
      tone: 'info',
      title: `X Auto ${version} is available`,
      body: this.status.mode === 'in-app' ? 'Download it from Settings → Security & app info when you’re ready.' : 'Open the release page to download it.'
    })
  }

  private onError(error: unknown): void {
    const { message, quiet } = describeUpdateError(error)
    this.deps.log.warn('Update check or download failed', { reason: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) })
    const manual = this.manualCheck // finishCheck() resets it
    const wasDownloading = this.status.state === 'downloading'
    this.finishCheck({ state: wasDownloading && this.status.available ? 'available' : 'error', error: message, progress: null })
    if (manual || !quiet) {
      // Each distinct failure is announced once per version, not on every periodic check.
      this.notifyOnce(`error:${this.status.available?.version ?? this.status.currentVersion}:${message}`, { tone: 'warning', title: 'Update problem', body: message }, !manual)
    }
  }

  private finishCheck(patch: Partial<UpdateStatus>): void {
    const lastCheckedAt = this.now().toISOString()
    this.deps.settings.set(SETTINGS_KEY, { ...(this.deps.settings.get<Record<string, unknown>>(SETTINGS_KEY) ?? {}), lastCheckedAt })
    this.set({ ...patch, lastCheckedAt })
    this.manualCheck = false
  }

  private notifyOnce(key: string, notice: { tone: 'info' | 'success' | 'warning'; title: string; body: string }, remember = true): void {
    const stored = this.deps.settings.get<{ notified?: string[] }>(SETTINGS_KEY) ?? {}
    const notified = stored.notified ?? []
    if (remember && notified.includes(key)) return
    this.deps.notifier.notify({ ...notice, event: 'systemNotices', to: '/settings?section=security' }, { key: `update:${key}` })
    if (remember) this.deps.settings.set(SETTINGS_KEY, { ...stored, notified: [...notified.slice(-49), key] })
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch }
    this.deps.onChange(this.get())
  }
}
