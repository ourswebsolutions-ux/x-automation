import { createHash } from 'node:crypto'
import type { MigrationRecord } from '@shared/types/storage'
import type { ScopedLogger } from '../logging/logger'
import { DatabaseError, type SqliteDatabase } from './driver'
import { APPLICATION_ID, LATEST_SCHEMA_VERSION, MIGRATIONS } from './migrations'

const checksum = (sql: string) => createHash('sha256').update(sql).digest('hex')

/**
 * Brings a database up to LATEST_SCHEMA_VERSION. Each migration runs in its
 * own transaction together with its bookkeeping, so a failure leaves the
 * database at the previous version.
 */
export function migrate(db: SqliteDatabase, log: ScopedLogger): number {
  const appId = db.pragma<number>('application_id') ?? 0
  const current = db.pragma<number>('user_version') ?? 0

  if (appId !== 0 && appId !== APPLICATION_ID) {
    throw new DatabaseError('This file is not an X Auto database', 'INCOMPATIBLE')
  }
  if (current > LATEST_SCHEMA_VERSION) {
    throw new DatabaseError(
      `Database schema v${current} was created by a newer version of X Auto (this build supports v${LATEST_SCHEMA_VERSION})`,
      'INCOMPATIBLE'
    )
  }

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    checksum    TEXT NOT NULL,
    applied_at  TEXT NOT NULL
  )`)
  if (appId === 0) db.exec(`PRAGMA application_id = ${APPLICATION_ID}`)

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    if (migration.disableForeignKeys) db.exec('PRAGMA foreign_keys = OFF')
    try {
      db.transaction(() => {
        db.exec(migration.sql)
        if (migration.disableForeignKeys) {
          const problems = db.all('PRAGMA foreign_key_check')
          if (problems.length) throw new DatabaseError(`Migration ${migration.version} left ${problems.length} broken reference(s)`, 'QUERY')
        }
        db.run('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (:version, :name, :checksum, :at)', {
          version: migration.version,
          name: migration.name,
          checksum: checksum(migration.sql),
          at: new Date().toISOString()
        })
        db.exec(`PRAGMA user_version = ${migration.version}`)
      })
    } finally {
      if (migration.disableForeignKeys) db.exec('PRAGMA foreign_keys = ON')
    }
    log.info(`Applied migration ${migration.version} (${migration.name})`)
  }

  // Detect edited migrations — a sign of a corrupted or hand-modified schema history.
  for (const row of db.all<{ version: number; checksum: string }>('SELECT version, checksum FROM schema_migrations')) {
    const known = MIGRATIONS.find((m) => m.version === row.version)
    if (known && checksum(known.sql) !== row.checksum) log.warn(`Migration ${row.version} checksum does not match this build`)
  }

  return db.pragma<number>('user_version') ?? 0
}

export function migrationHistory(db: SqliteDatabase): MigrationRecord[] {
  return db
    .all<{ version: number; name: string; applied_at: string }>('SELECT version, name, applied_at FROM schema_migrations ORDER BY version')
    .map((row) => ({ version: row.version, name: row.name, appliedAt: row.applied_at }))
}
