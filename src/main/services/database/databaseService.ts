import { copyFile, mkdir, open as openFile, rename, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite'
import type { BackupSummary, DatabaseInfo, HealthReport } from '@shared/types/storage'
import type { ScopedLogger } from '../logging/logger'
import { DatabaseError, SqliteDatabase, toDatabaseError } from './driver'
import { APPLICATION_ID, LATEST_SCHEMA_VERSION, REQUIRED_TABLES } from './migrations'
import { migrate, migrationHistory } from './migrator'

const SQLITE_HEADER = 'SQLite format 3\0'

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

async function removeSidecars(path: string): Promise<void> {
  await Promise.all(['-wal', '-shm', '-journal'].map((suffix) => rm(`${path}${suffix}`, { force: true })))
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

/**
 * Owns the SQLite file: opening, migrating, health, compaction, online
 * backups, backup validation and transactional restore.
 */
export class DatabaseService {
  readonly db: SqliteDatabase
  private recoveredFrom: string | null = null

  constructor(
    readonly path: string,
    private readonly log: ScopedLogger
  ) {
    this.db = new SqliteDatabase(path)
  }

  /**
   * Opens and migrates the database. An unreadable or foreign file is moved
   * aside (never deleted) and a fresh database is created, so the app always
   * starts and the user can restore from a backup.
   */
  async open(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    try {
      this.openAndMigrate()
    } catch (error) {
      const dbError = toDatabaseError(error, 'Database startup failed')
      if (dbError.code !== 'CORRUPT' && dbError.code !== 'INCOMPATIBLE') throw dbError
      this.db.close()
      const preserved = `${this.path}.unreadable-${stamp()}`
      await rename(this.path, preserved).catch(() => undefined)
      await removeSidecars(this.path)
      this.recoveredFrom = preserved
      this.log.error(`Database could not be used (${dbError.message}); preserved as ${basename(preserved)} and started fresh`)
      this.openAndMigrate()
    }
  }

  private openAndMigrate(): void {
    this.db.open()
    const check = this.db.pragma<string>('quick_check')
    if (check !== 'ok') throw new DatabaseError(`Integrity check failed: ${check}`, 'CORRUPT')
    const version = migrate(this.db, this.log)
    this.log.info(`Database ready (schema v${version})`)
  }

  get recoveredPath(): string | null {
    return this.recoveredFrom
  }

  async info(lastBackupAt: string | null): Promise<DatabaseInfo> {
    const count = (table: string) => this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0
    const walSize = await fileSize(`${this.path}-wal`)
    return {
      path: this.path,
      sizeBytes: (await fileSize(this.path)) + walSize,
      schemaVersion: this.db.pragma<number>('user_version') ?? 0,
      latestSchemaVersion: LATEST_SCHEMA_VERSION,
      journalMode: String(this.db.pragma('journal_mode') ?? 'unknown'),
      sqliteVersion: this.db.get<{ v: string }>('SELECT sqlite_version() AS v')?.v ?? 'unknown',
      migrations: migrationHistory(this.db),
      lastBackupAt,
      counts: { drafts: count('drafts'), providers: count('provider_configs'), logs: count('logs'), activity: count('activity') },
      recoveredFrom: this.recoveredFrom ? basename(this.recoveredFrom) : null
    }
  }

  health(): HealthReport {
    const started = performance.now()
    const checks: HealthReport['checks'] = []
    const attempt = (name: string, fn: () => { ok: boolean; detail: string }) => {
      try {
        checks.push({ name, ...fn() })
      } catch (error) {
        checks.push({ name, ok: false, detail: toDatabaseError(error, name).message })
      }
    }

    attempt('Connection', () => {
      this.db.get('SELECT 1')
      return { ok: true, detail: 'Responding' }
    })
    attempt('Integrity', () => {
      const result = this.db.pragma<string>('integrity_check')
      return { ok: result === 'ok', detail: result === 'ok' ? 'No corruption found' : String(result) }
    })
    attempt('Foreign keys', () => {
      const enabled = this.db.pragma<number>('foreign_keys') === 1
      const violations = this.db.all('PRAGMA foreign_key_check').length
      return {
        ok: enabled && violations === 0,
        detail: !enabled ? 'Enforcement is off' : violations ? `${violations} orphaned rows` : 'Enforced, no violations'
      }
    })
    attempt('Schema version', () => {
      const version = this.db.pragma<number>('user_version') ?? 0
      return {
        ok: version === LATEST_SCHEMA_VERSION,
        detail: version === LATEST_SCHEMA_VERSION ? `v${version} (current)` : `v${version}, expected v${LATEST_SCHEMA_VERSION}`
      }
    })
    attempt('Journal', () => {
      const mode = String(this.db.pragma('journal_mode'))
      return { ok: mode === 'wal', detail: mode === 'wal' ? 'Write-ahead log' : `Mode: ${mode}` }
    })

    return {
      ok: checks.every((c) => c.ok),
      checkedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started),
      checks
    }
  }

  /** Rebuilds the file to reclaim space. */
  compact(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    this.db.exec('VACUUM')
    this.log.info('Database compacted')
  }

  /**
   * Writes a consistent copy using SQLite's online backup API — safe while the
   * app keeps writing. The copy is validated before success is reported.
   */
  async backupTo(destination: string): Promise<BackupSummary> {
    if (destination === this.path) throw new DatabaseError('Cannot back up over the live database', 'QUERY')
    await mkdir(dirname(destination), { recursive: true })
    const temp = `${destination}.partial`
    await rm(temp, { force: true })
    try {
      await sqliteBackup(this.db.handle, temp)
      // Make the copy self-contained (no WAL sidecar needed to read it).
      const copy = new DatabaseSync(temp)
      copy.exec('PRAGMA journal_mode = DELETE')
      copy.close()
      const inspection = await this.inspect(temp)
      if (!inspection.ok) throw new DatabaseError(`Backup failed validation: ${inspection.reason}`, 'CORRUPT')
      await rm(destination, { force: true })
      await rename(temp, destination)
      return { ...inspection.summary, fileName: basename(destination) }
    } catch (error) {
      await rm(temp, { force: true })
      throw toDatabaseError(error, 'Backup failed')
    }
  }

  /** Validates a candidate backup file without modifying it. */
  async inspect(path: string): Promise<{ ok: true; summary: BackupSummary } | { ok: false; reason: string }> {
    let size: number
    let modifiedAt: string
    try {
      const info = await stat(path)
      size = info.size
      modifiedAt = info.mtime.toISOString()
    } catch {
      return { ok: false, reason: 'The file could not be read.' }
    }
    if (size < 512) return { ok: false, reason: 'The file is too small to be a database backup.' }

    const handle = await openFile(path, 'r')
    const header = Buffer.alloc(16)
    await handle.read(header, 0, 16, 0)
    await handle.close()
    if (header.toString('latin1') !== SQLITE_HEADER) return { ok: false, reason: 'This is not an SQLite database file.' }

    let candidate: DatabaseSync | null = null
    try {
      candidate = new DatabaseSync(path, { readOnly: true })
      const one = <T>(sql: string) => candidate!.prepare(sql).get() as T | undefined
      if (one<{ application_id: number }>('PRAGMA application_id')?.application_id !== APPLICATION_ID) {
        return { ok: false, reason: 'This SQLite file was not created by Axora Relay.' }
      }
      const version = one<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0
      if (version < 1) return { ok: false, reason: 'The backup has no schema version.' }
      if (version > LATEST_SCHEMA_VERSION) {
        return { ok: false, reason: `The backup uses schema v${version}, which needs a newer version of Axora Relay.` }
      }
      const integrity = one<{ integrity_check: string }>('PRAGMA integrity_check')?.integrity_check
      if (integrity !== 'ok') return { ok: false, reason: 'The backup is corrupted (integrity check failed).' }
      const tables = new Set(
        (candidate.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name)
      )
      const missing = REQUIRED_TABLES.filter((t) => !tables.has(t))
      if (missing.length) return { ok: false, reason: `The backup is incomplete (missing ${missing.join(', ')}).` }
      const count = (table: string) => one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0
      return {
        ok: true,
        summary: {
          fileName: basename(path),
          sizeBytes: size,
          schemaVersion: version,
          modifiedAt,
          counts: { drafts: count('drafts'), providers: count('provider_configs'), logs: count('logs') },
          needsUpgrade: version < LATEST_SCHEMA_VERSION
        }
      }
    } catch {
      return { ok: false, reason: 'The file is damaged or is not a readable database.' }
    } finally {
      candidate?.close()
    }
  }

  /**
   * Replaces the live database with a validated backup. A recovery copy is
   * taken first; if anything fails, the recovery copy is put back.
   */
  async restore(source: string, recoveryPath: string): Promise<void> {
    const inspection = await this.inspect(source)
    if (!inspection.ok) throw new DatabaseError(inspection.reason, 'CORRUPT')

    await this.backupTo(recoveryPath)
    this.log.info(`Recovery backup written: ${basename(recoveryPath)}`)

    const staged = `${this.path}.restore-${stamp()}`
    await copyFile(source, staged)
    this.db.close()
    try {
      await removeSidecars(this.path)
      await rename(staged, this.path)
      this.recoveredFrom = null
      this.openAndMigrate()
      this.log.success(`Restored database from ${basename(source)}`)
    } catch (error) {
      this.log.error('Restore failed; rolling back to the recovery backup', error)
      this.db.close()
      await removeSidecars(this.path)
      await copyFile(recoveryPath, this.path)
      this.openAndMigrate()
      throw toDatabaseError(error, 'Restore failed and was rolled back')
    } finally {
      if (existsSync(staged)) await rm(staged, { force: true })
    }
  }

  close(): void {
    if (!this.db.isOpen) return
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      // Best effort before close.
    }
    this.db.close()
    this.log.info('Database closed')
  }
}

export const defaultDatabasePath = (userData: string) => join(userData, 'data', 'relay.db')
