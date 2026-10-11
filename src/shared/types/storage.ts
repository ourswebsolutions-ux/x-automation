import type { Timestamp } from './domain'

export interface MigrationRecord {
  version: number
  name: string
  appliedAt: Timestamp
}

export interface DatabaseInfo {
  path: string
  sizeBytes: number
  schemaVersion: number
  latestSchemaVersion: number
  journalMode: string
  sqliteVersion: string
  migrations: MigrationRecord[]
  lastBackupAt: Timestamp | null
  counts: { drafts: number; providers: number; logs: number; activity: number }
  /** Set when an unreadable database was moved aside at startup. */
  recoveredFrom: string | null
}

export interface HealthCheck {
  name: string
  ok: boolean
  detail: string
}

export interface HealthReport {
  ok: boolean
  checkedAt: Timestamp
  durationMs: number
  checks: HealthCheck[]
}

export interface BackupSummary {
  fileName: string
  sizeBytes: number
  schemaVersion: number
  modifiedAt: Timestamp
  /** Record counts in the backup (drafts, schedules, tasks, links, accounts, usageRecords, …). */
  counts: { drafts: number; providers: number; logs: number } & Record<string, number>
  /** True if restoring will migrate the backup to the current schema. */
  needsUpgrade: boolean
  /** bundle = database and images (.axrbackup); database-only = an older .sqlite backup. */
  format?: 'bundle' | 'database-only'
  includesImages?: boolean
  createdAt?: Timestamp
  images?: number
}

export interface BackupSettings {
  /** Where backups are saved. */
  folder: string
  schedule: 'off' | 'daily' | 'weekly'
  /** Automatic backups kept in the folder (older ones are removed). */
  keep: number
  lastAutoAt?: Timestamp | null
}

export const DEFAULT_BACKUP_SETTINGS: Omit<BackupSettings, 'folder'> = { schedule: 'off', keep: 7, lastAutoAt: null }

export interface BackupStatus {
  settings: BackupSettings
  lastBackupAt: Timestamp | null
  lastResult: { at: Timestamp; ok: boolean; kind: 'manual' | 'auto'; fileName: string | null; error: string | null } | null
  busy: 'backup' | 'restore' | null
  /** What a backup does not contain, in plain words. */
  notIncluded: string[]
}

export type BackupInspection =
  | { status: 'cancelled' }
  | { status: 'invalid'; fileName: string; reason: string }
  | { status: 'valid'; token: string; summary: BackupSummary }

export type BackupCreateResult = { status: 'cancelled' } | { status: 'created'; fileName: string; sizeBytes: number }

export interface RecoveryBackup {
  id: string
  fileName: string
  createdAt: Timestamp
  sizeBytes: number
}

export interface CredentialStatus {
  /** Electron reports encryption as available. */
  available: boolean
  /** Encryption is backed by a real OS secret store (not a fixed fallback key). */
  secure: boolean
  backend: string
  detail: string
  storedCount: number
}

export type FileExportResult = { status: 'cancelled' } | { status: 'saved'; fileName: string; count: number }
