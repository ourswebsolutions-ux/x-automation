import { app, dialog, shell, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { access, constants, mkdir, readdir, rename, rm, stat, statfs } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type {
  BackupCreateResult,
  BackupInspection,
  BackupSettings,
  BackupStatus,
  BackupSummary,
  RecoveryBackup
} from '@shared/types/storage'
import { DEFAULT_BACKUP_SETTINGS } from '@shared/types/storage'
import type { DatabaseService } from '../database/databaseService'
import { LATEST_SCHEMA_VERSION } from '../database/migrations'
import type { SettingsRepository } from '../database/repositories'
import { ConflictError, NotFoundError, ValidationError } from '../errors'
import type { ScopedLogger } from '../logging/logger'
import type { Notifier } from '../notifications/notifier'
import { ArchiveError, collect, readArchive, writeArchive, type ArchiveFile } from './archive'

const TOKEN_TTL_MS = 10 * 60_000
const KEEP_SAFETY_BACKUPS = 10
const RECOVERY_FILE = /^[A-Za-z0-9._-]+\.(sqlite|axrbackup)$/
const BUNDLE_EXT = '.axrbackup'
const AUTO_FILE = /^axora-relay-backup-\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?-auto\.axrbackup$/
const FORMAT = 'axora-relay-backup'
const FORMAT_VERSION = 1
const SETTINGS_KEY = 'backup.settings'
const RESULT_KEY = 'backup.lastResult'
export const LAST_BACKUP_KEY = 'backup.lastAt'

const stamp = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

interface Manifest {
  format: string
  formatVersion: number
  kind: 'manual' | 'auto' | 'safety'
  createdAt: string
  appVersion: string
  schemaVersion: number
  counts: Record<string, number>
  files: ArchiveFile[]
  notIncluded: string[]
}

interface Deps {
  database: DatabaseService
  settings: SettingsRepository
  /** Folder of library images (relative paths come from image_assets.file_path). */
  assetDir: string
  /** Safety backups taken before a restore. */
  recoveryDir: string
  /** Temporary space for building and checking backups. */
  workDir: string
  notifier: Notifier
  log: ScopedLogger
  /** Stops background work (queue, scheduler) before a restore… */
  beforeRestore?: () => Promise<void>
  /** …and starts it again afterwards (also after a failed restore). */
  afterRestore?: () => void
  onChange?: () => void
}

type Candidate =
  | { kind: 'bundle'; path: string; stagingDir: string; dbPath: string; summary: BackupSummary; expires: number }
  | { kind: 'legacy'; path: string; summary: BackupSummary; expires: number }

const NOT_INCLUDED = [
  'API keys and proxy passwords (encrypted with this computer’s user account — on another computer, enter them again)',
  'IX Browser profiles, cookies and signed-in sessions (kept by IX Browser)',
  'Temporary files and caches'
]

/** Turns file-system errors into plain language. */
function plain(error: unknown, fallback: string): string {
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'ENOSPC') return 'There is not enough free space for the backup.'
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'Axora Relay can’t write to that folder. Choose another one.'
  if (code === 'ENOENT') return 'The backup folder is not available. Choose another one.'
  if (error instanceof ArchiveError || error instanceof ValidationError || error instanceof ConflictError) return error.message
  return fallback
}

/**
 * Backup and restore of everything Axora Relay owns: the database (drafts,
 * schedules, queue, links, accounts, usage history, settings, logs) and the
 * image library, in one verified file. A backup is only reported as done
 * after it was read back and every file matched its checksum. A restore only
 * starts from a backup that passed the same checks, takes a safety backup
 * first, and puts everything back if any step fails. Only one backup or
 * restore runs at a time.
 */
export class BackupService {
  private readonly candidates = new Map<string, Candidate>()
  private busy: 'backup' | 'restore' | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly deps: Deps) {}

  // ── settings ─────────────────────────────────────────────────────────────

  getSettings(): BackupSettings {
    const stored = this.deps.settings.get<Partial<BackupSettings>>(SETTINGS_KEY) ?? {}
    return { ...DEFAULT_BACKUP_SETTINGS, folder: join(app.getPath('documents'), 'Axora Relay Backups'), ...stored }
  }

  updateSettings(patch: Partial<Pick<BackupSettings, 'schedule' | 'keep'>>): BackupSettings {
    const next = { ...this.getSettings(), ...patch }
    if (!['off', 'daily', 'weekly'].includes(next.schedule)) throw new ValidationError('Choose off, daily or weekly.')
    if (!Number.isInteger(next.keep) || next.keep < 1 || next.keep > 100) throw new ValidationError('Keep between 1 and 100 automatic backups.')
    this.deps.settings.set(SETTINGS_KEY, next)
    this.deps.onChange?.()
    return next
  }

  async chooseFolder(window: BrowserWindow | null): Promise<BackupSettings | null> {
    const options = { title: 'Choose where backups are saved', defaultPath: this.getSettings().folder, properties: ['openDirectory' as const, 'createDirectory' as const] }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    const folder = result.filePaths[0]
    if (result.canceled || !folder) return null
    await this.assertWritable(folder)
    const next = { ...this.getSettings(), folder }
    this.deps.settings.set(SETTINGS_KEY, next)
    this.deps.onChange?.()
    return next
  }

  status(): BackupStatus {
    return {
      settings: this.getSettings(),
      lastBackupAt: this.lastBackupAt(),
      lastResult: this.deps.settings.get<BackupStatus['lastResult']>(RESULT_KEY) ?? null,
      busy: this.busy,
      notIncluded: NOT_INCLUDED
    }
  }

  lastBackupAt(): string | null {
    return this.deps.settings.get<string>(LAST_BACKUP_KEY) ?? null
  }

  // ── backups ──────────────────────────────────────────────────────────────

  /** Manual backup to the chosen folder. */
  async create(_window?: BrowserWindow | null): Promise<BackupCreateResult> {
    const result = await this.run('manual', this.getSettings().folder)
    return { status: 'created', fileName: result.fileName, sizeBytes: result.sizeBytes }
  }

  /** Starts automatic backups (checked at start-up and hourly while the app runs). */
  startSchedule(): void {
    this.stopSchedule()
    void this.cleanupWork()
    const check = () => void this.runAutoIfDue()
    setTimeout(check, 2 * 60_000).unref?.()
    this.timer = setInterval(check, 60 * 60_000)
    this.timer.unref?.()
  }

  stopSchedule(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async runAutoIfDue(now = new Date()): Promise<boolean> {
    const settings = this.getSettings()
    if (settings.schedule === 'off' || this.busy) return false
    const period = settings.schedule === 'daily' ? 86_400_000 : 7 * 86_400_000
    const last = settings.lastAutoAt ? Date.parse(settings.lastAutoAt) : 0
    if (now.getTime() - last < period) return false
    try {
      const result = await this.run('auto', settings.folder)
      this.deps.settings.set(SETTINGS_KEY, { ...this.getSettings(), lastAutoAt: new Date().toISOString() })
      await this.pruneAuto(settings.folder, settings.keep)
      this.deps.notifier.notify({ tone: 'success', event: 'systemNotices', title: 'Backup completed successfully', body: `Automatic backup saved (${result.fileName}).`, to: '/settings?section=backup' })
      this.deps.notifier.clear('backup-auto-failed')
      return true
    } catch (error) {
      this.deps.notifier.notify(
        { tone: 'danger', event: 'systemNotices', title: 'Automatic backup failed', body: plain(error, 'The backup could not be completed.'), to: '/settings?section=backup' },
        { key: 'backup-auto-failed', quietMs: 12 * 60 * 60_000 }
      )
      return false
    }
  }

  /** Builds, verifies and saves one backup bundle. */
  private async run(kind: Manifest['kind'], folder: string): Promise<{ fileName: string; path: string; sizeBytes: number }> {
    if (kind !== 'safety') this.lock('backup')
    const work = join(this.deps.workDir, `backup-${randomUUID()}`)
    const base = `axora-relay-backup-${stamp()}`
    const suffix = kind === 'manual' ? '' : `-${kind}`
    // Never overwrite an existing backup (two in the same second get -2, -3, …).
    let fileName = `${base}${suffix}${BUNDLE_EXT}`
    for (let n = 2; existsSync(join(folder, fileName)) || existsSync(join(folder, `${fileName}.partial`)); n++) fileName = `${base}-${n}${suffix}${BUNDLE_EXT}`
    const destination = join(folder, fileName)
    const partial = `${destination}.partial`
    try {
      await mkdir(folder, { recursive: true })
      await this.assertWritable(folder)
      await mkdir(work, { recursive: true })

      // A consistent copy of the database (SQLite online backup, validated).
      const dbCopy = join(work, 'relay.db')
      await this.deps.database.backupTo(dbCopy)
      const counts = this.countsOf(dbCopy)
      const assets = await this.assetFiles(dbCopy)
      const assetBytes = assets.reduce((sum, a) => sum + a.size, 0)
      const dbBytes = (await stat(dbCopy)).size
      await this.assertSpace(folder, (dbBytes + assetBytes) * 1.1 + 5 * 1024 * 1024)

      const files = await writeArchive(
        partial,
        [{ name: 'data/relay.db', path: dbCopy }, ...assets.map((a) => ({ name: `assets/${a.relative}`, path: a.path }))],
        (written) =>
          Buffer.from(
            JSON.stringify(
              {
                format: FORMAT,
                formatVersion: FORMAT_VERSION,
                kind,
                createdAt: new Date().toISOString(),
                appVersion: app.getVersion(),
                schemaVersion: LATEST_SCHEMA_VERSION,
                counts: { ...counts, images: assets.length },
                files: written,
                notIncluded: NOT_INCLUDED
              } satisfies Manifest,
              null,
              2
            )
          )
      )
      // Read it back: every file must match its checksum, and the database must open.
      await this.verify(partial, files, work)
      await rename(partial, destination)
      const sizeBytes = (await stat(destination)).size
      if (kind !== 'safety') {
        const at = new Date().toISOString()
        this.deps.settings.set(LAST_BACKUP_KEY, at)
        this.deps.settings.set(RESULT_KEY, { at, ok: true, kind, fileName, error: null })
      }
      this.deps.log.success(`Backup verified and saved (${kind})`, { sizeBytes, images: assets.length, drafts: counts.drafts })
      return { fileName, path: destination, sizeBytes }
    } catch (error) {
      await rm(partial, { force: true })
      const message = plain(error, 'The backup could not be completed.')
      if (kind !== 'safety') this.deps.settings.set(RESULT_KEY, { at: new Date().toISOString(), ok: false, kind, fileName: null, error: message })
      this.deps.log.error(`Backup failed (${kind})`, error)
      throw new ValidationError(message)
    } finally {
      await rm(work, { recursive: true, force: true })
      if (kind !== 'safety') this.unlock()
      this.deps.onChange?.()
    }
  }

  private async verify(path: string, written: ArchiveFile[], work: string): Promise<void> {
    const check = join(work, 'verify.db')
    const manifest = collect(1024 * 1024)
    const read = await readArchive(path, ({ name }) => (name === 'data/relay.db' ? createWriteStream(check) : name === 'manifest.json' ? manifest.sink : null))
    const expected = new Map(written.map((f) => [f.name, f]))
    if (read.length !== written.length || read.some((f) => expected.get(f.name)?.sha256 !== f.sha256)) throw new ArchiveError('The backup did not pass its integrity check.')
    const parsed = JSON.parse(manifest.result().toString('utf8')) as Manifest
    if (parsed.files.length !== written.length - 1) throw new ArchiveError('The backup manifest is incomplete.')
    const inspection = await this.deps.database.inspect(check)
    if (!inspection.ok) throw new ArchiveError(`The database in the backup is not readable: ${inspection.reason}`)
  }

  // ── restore ──────────────────────────────────────────────────────────────

  async inspectFile(window: BrowserWindow | null): Promise<BackupInspection> {
    const options = {
      title: 'Choose a backup to restore',
      defaultPath: existsSync(this.getSettings().folder) ? this.getSettings().folder : app.getPath('documents'),
      filters: [
        { name: 'Axora Relay backup', extensions: ['axrbackup', 'sqlite', 'db'] },
        { name: 'All files', extensions: ['*'] }
      ],
      properties: ['openFile' as const]
    }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    const path = result.filePaths[0]
    if (result.canceled || !path) return { status: 'cancelled' }
    return this.inspectPath(path)
  }

  async inspectRecovery(id: string): Promise<BackupInspection> {
    if (!RECOVERY_FILE.test(id)) throw new ValidationError('Unknown safety backup.')
    const path = join(this.deps.recoveryDir, id)
    if (!existsSync(path)) throw new NotFoundError('That safety backup no longer exists.')
    return this.inspectPath(path)
  }

  /** Checks a backup completely (checksums, database) without touching current data. */
  async inspectPath(path: string): Promise<BackupInspection> {
    await this.pruneCandidates()
    if (resolve(path) === resolve(this.deps.database.path)) return { status: 'invalid', fileName: basename(path), reason: 'That is the live database.' }
    if (!path.endsWith(BUNDLE_EXT)) {
      const inspection = await this.deps.database.inspect(path)
      if (!inspection.ok) return { status: 'invalid', fileName: basename(path), reason: inspection.reason }
      const token = randomUUID()
      const summary: BackupSummary = { ...inspection.summary, format: 'database-only', includesImages: false, createdAt: inspection.summary.modifiedAt, images: 0 }
      this.candidates.set(token, { kind: 'legacy', path, summary, expires: Date.now() + TOKEN_TTL_MS })
      return { status: 'valid', token, summary }
    }
    const stagingDir = join(this.deps.workDir, `restore-${randomUUID()}`)
    try {
      const size = (await stat(path)).size
      await mkdir(stagingDir, { recursive: true })
      await this.assertSpace(this.deps.workDir, size * 3 + 10 * 1024 * 1024)
      const manifest = collect(1024 * 1024)
      const root = resolve(stagingDir) + sep
      const read = await readArchive(path, async ({ name }) => {
        if (name === 'manifest.json') return manifest.sink
        const target = resolve(stagingDir, name)
        if (!target.startsWith(root)) throw new ArchiveError('The backup contains an unexpected file name.')
        await mkdir(dirname(target), { recursive: true })
        return createWriteStream(target, { flags: 'wx' })
      })
      let parsed: Manifest
      try {
        parsed = JSON.parse(manifest.result().toString('utf8')) as Manifest
      } catch {
        throw new ArchiveError('The backup has no readable manifest.')
      }
      if (parsed.format !== FORMAT || parsed.formatVersion !== FORMAT_VERSION) throw new ArchiveError('This is not an Axora Relay backup, or it needs a newer version of the app.')
      const actual = new Map(read.filter((f) => f.name !== 'manifest.json').map((f) => [f.name, f]))
      if (actual.size !== parsed.files.length || parsed.files.some((f) => actual.get(f.name)?.sha256 !== f.sha256 || actual.get(f.name)?.size !== f.size)) {
        throw new ArchiveError('The backup did not pass its integrity check — it may be damaged or incomplete.')
      }
      const dbPath = join(stagingDir, 'data', 'relay.db')
      const inspection = await this.deps.database.inspect(dbPath)
      if (!inspection.ok) throw new ArchiveError(inspection.reason)
      const summary: BackupSummary = {
        ...inspection.summary,
        fileName: basename(path),
        sizeBytes: size,
        format: 'bundle',
        includesImages: true,
        createdAt: parsed.createdAt,
        images: parsed.counts.images ?? 0,
        counts: { ...inspection.summary.counts, ...this.countsOf(dbPath) }
      }
      const token = randomUUID()
      this.candidates.set(token, { kind: 'bundle', path, stagingDir, dbPath, summary, expires: Date.now() + TOKEN_TTL_MS })
      return { status: 'valid', token, summary }
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true })
      const reason = plain(error, 'The backup could not be read.')
      this.deps.log.warn(`Rejected backup ${basename(path)}: ${reason}`)
      return { status: 'invalid', fileName: basename(path), reason }
    }
  }

  /**
   * Replaces current data with a checked backup. A safety backup of the
   * current state is taken first; if anything fails, everything is put back.
   */
  async restore(token: string): Promise<void> {
    await this.pruneCandidates()
    const candidate = this.candidates.get(token)
    if (!candidate) throw new ValidationError('This restore request expired. Choose the backup again.')
    this.lock('restore')
    this.candidates.delete(token)
    await this.deps.beforeRestore?.()
    const parked = `${this.deps.assetDir}.pre-restore-${randomUUID().slice(0, 8)}`
    let assetsSwapped = false
    try {
      // 1. Safety backup of what is there now — no restore without it.
      await mkdir(this.deps.recoveryDir, { recursive: true })
      await this.run('safety', this.deps.recoveryDir).catch((error: unknown) => {
        throw new ValidationError(`The restore was not started: a safety backup of your current data could not be made. ${plain(error, '')}`.trim())
      })
      // 2. Images (bundles only): park the current folder, move the backup's in.
      if (candidate.kind === 'bundle') {
        const incoming = join(candidate.stagingDir, 'assets')
        if (!existsSync(incoming)) await mkdir(incoming, { recursive: true })
        if (existsSync(this.deps.assetDir)) await rename(this.deps.assetDir, parked)
        await rename(incoming, this.deps.assetDir)
        assetsSwapped = true
      }
      // 3. Database (validated again; rolls itself back on failure).
      const dbRecovery = join(this.deps.workDir, `db-before-restore-${randomUUID()}.sqlite`)
      try {
        await this.deps.database.restore(candidate.kind === 'bundle' ? candidate.dbPath : candidate.path, dbRecovery)
      } finally {
        await rm(dbRecovery, { force: true })
      }
      if (assetsSwapped) await rm(parked, { recursive: true, force: true })
      await this.pruneSafety()
      this.deps.log.success(`Restored from a backup (${candidate.kind === 'bundle' ? 'database and images' : 'database only'})`)
      this.deps.notifier.notify({ tone: 'success', event: 'systemNotices', title: 'Restore completed', body: candidate.kind === 'bundle' ? 'Your data and images were restored.' : 'Your data was restored. Images were not part of this backup.' })
    } catch (error) {
      if (assetsSwapped) {
        await rm(this.deps.assetDir, { recursive: true, force: true }).catch(() => undefined)
        if (existsSync(parked)) await rename(parked, this.deps.assetDir).catch(() => undefined)
      }
      this.deps.log.error('Restore failed; current data was kept', error)
      throw new ValidationError(error instanceof ValidationError ? error.message : `The restore failed and your current data was kept. ${plain(error, '')}`.trim())
    } finally {
      if (candidate.kind === 'bundle') await rm(candidate.stagingDir, { recursive: true, force: true })
      this.unlock()
      this.deps.afterRestore?.()
      this.deps.onChange?.()
    }
  }

  async listRecovery(): Promise<RecoveryBackup[]> {
    let names: string[]
    try {
      names = (await readdir(this.deps.recoveryDir)).filter((name) => RECOVERY_FILE.test(name))
    } catch {
      return []
    }
    const items = await Promise.all(
      names.map(async (name) => {
        const info = await stat(join(this.deps.recoveryDir, name))
        return { id: name, fileName: name, createdAt: info.mtime.toISOString(), sizeBytes: info.size }
      })
    )
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async openFolder(): Promise<void> {
    const folder = this.getSettings().folder
    await mkdir(folder, { recursive: true })
    await shell.openPath(folder)
  }

  // ── internals ────────────────────────────────────────────────────────────

  private lock(kind: 'backup' | 'restore'): void {
    if (this.busy) throw new ConflictError(this.busy === 'restore' ? 'A restore is in progress.' : 'A backup is in progress. Try again when it finishes.')
    this.busy = kind
    this.deps.onChange?.()
  }

  private unlock(): void {
    this.busy = null
  }

  private async assertWritable(folder: string): Promise<void> {
    try {
      await access(folder, constants.W_OK)
    } catch (error) {
      throw new ValidationError(plain(error, 'Axora Relay can’t write to that folder. Choose another one.'))
    }
  }

  private async assertSpace(folder: string, needed: number): Promise<void> {
    try {
      const info = await statfs(folder)
      if (info.bavail * info.bsize < needed) throw new ValidationError('There is not enough free space for the backup.')
    } catch (error) {
      if (error instanceof ValidationError) throw error
      // statfs unsupported: the write itself will report a full disk.
    }
  }

  /** Library image files referenced by the database copy that exist on disk. */
  private async assetFiles(dbPath: string): Promise<{ relative: string; path: string; size: number }[]> {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    let rows: { file_path: string }[]
    try {
      rows = db.prepare("SELECT DISTINCT file_path FROM image_assets WHERE file_path IS NOT NULL AND file_path != ''").all() as { file_path: string }[]
    } finally {
      db.close()
    }
    const root = resolve(this.deps.assetDir) + sep
    const out: { relative: string; path: string; size: number }[] = []
    for (const { file_path } of rows) {
      const relative = file_path.replace(/\\/g, '/')
      const full = resolve(this.deps.assetDir, relative)
      if (!full.startsWith(root) || !/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(relative)) continue
      try {
        const info = await stat(full)
        if (info.isFile()) out.push({ relative, path: full, size: info.size })
      } catch {
        // Missing files are already shown as unavailable in the app; nothing to back up.
      }
    }
    return out
  }

  private countsOf(dbPath: string): Record<string, number> {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const count = (table: string) => {
      try {
        return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
      } catch {
        return 0
      }
    }
    try {
      return {
        drafts: count('drafts'),
        schedules: count('scheduled_posts'),
        tasks: count('tasks'),
        links: count('post_links'),
        accounts: count('accounts'),
        engagementTasks: count('engagement_tasks'),
        usageRecords: count('ai_usage'),
        providers: count('provider_configs'),
        logs: count('logs')
      }
    } finally {
      db.close()
    }
  }

  /** Removes work folders left by an interrupted backup or restore (e.g. the app was closed mid-way). */
  private async cleanupWork(): Promise<void> {
    try {
      for (const name of await readdir(this.deps.workDir)) {
        if (/^(backup|restore)-[0-9a-f-]{36}$/.test(name)) await rm(join(this.deps.workDir, name), { recursive: true, force: true })
      }
    } catch {
      // Nothing to clean.
    }
  }

  private async pruneAuto(folder: string, keep: number): Promise<void> {
    const names = (await readdir(folder)).filter((n) => AUTO_FILE.test(n)).sort().reverse()
    await Promise.all(names.slice(keep).map((n) => rm(join(folder, n), { force: true })))
  }

  private async pruneSafety(): Promise<void> {
    const items = await this.listRecovery()
    await Promise.all(items.slice(KEEP_SAFETY_BACKUPS).map((item) => rm(join(this.deps.recoveryDir, item.fileName), { force: true })))
  }

  private async pruneCandidates(): Promise<void> {
    const now = Date.now()
    for (const [token, candidate] of this.candidates) {
      if (candidate.expires >= now) continue
      this.candidates.delete(token)
      if (candidate.kind === 'bundle') await rm(candidate.stagingDir, { recursive: true, force: true })
    }
  }
}
