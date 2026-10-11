import { isAiAdapterId } from '@shared/config/aiAdapters'
import type { NotificationChannelPrefs, NotificationEvent } from '@shared/types/preferences'
import { DEFAULT_PROVIDER_SETTINGS, type ProviderKind, type ProviderSettings } from '@shared/types/providers'
import type { LogEntry, LogMeta } from '@shared/types/system'
import type { Params, SqliteDatabase } from '../driver'
import type {
  CredentialRefRecord,
  CredentialRefRepository,
  LogRepository,
  NotificationPreferencesRepository,
  ProviderRecord,
  ProviderRepository,
  SettingsRepository
} from '../repositories'
import { parseJson, str, strOrNull, type Row } from './tableRepository'

const now = () => new Date().toISOString()

export function settingsRepository(db: SqliteDatabase): SettingsRepository {
  const write = (key: string, value: unknown) =>
    db.run(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (:key, :value, :at)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      { key, value: JSON.stringify(value), at: now() }
    )
  return {
    get<T>(key: string) {
      const row = db.get<{ value: string }>('SELECT value FROM app_settings WHERE key = :key', { key })
      return row ? parseJson<T | undefined>(row.value, undefined) : undefined
    },
    set: write,
    setMany(entries) {
      db.transaction(() => Object.entries(entries).forEach(([key, value]) => write(key, value)))
    },
    entries(prefix) {
      const rows = db.all<{ key: string; value: string }>("SELECT key, value FROM app_settings WHERE key LIKE :pattern ESCAPE '\\'", {
        pattern: `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
      })
      return Object.fromEntries(rows.map((r) => [r.key.slice(prefix.length), parseJson<unknown>(r.value, undefined)]))
    },
    delete(key) {
      db.run('DELETE FROM app_settings WHERE key = :key', { key })
    }
  }
}

export function notificationPreferencesRepository(db: SqliteDatabase): NotificationPreferencesRepository {
  return {
    all() {
      const rows = db.all<{ event: string; in_app: number; desktop: number }>('SELECT event, in_app, desktop FROM notification_preferences')
      return Object.fromEntries(rows.map((r) => [r.event, { inApp: r.in_app === 1, desktop: r.desktop === 1 }]))
    },
    save(prefs: Record<NotificationEvent, NotificationChannelPrefs>) {
      db.transaction(() => {
        for (const [event, channels] of Object.entries(prefs)) {
          db.run(
            `INSERT INTO notification_preferences (event, in_app, desktop, updated_at) VALUES (:event, :inApp, :desktop, :at)
             ON CONFLICT(event) DO UPDATE SET in_app = excluded.in_app, desktop = excluded.desktop, updated_at = excluded.updated_at`,
            { event, inApp: channels.inApp, desktop: channels.desktop, at: now() }
          )
        }
      })
    }
  }
}

const providerFromRow = (r: Row): ProviderRecord => ({
  id: str(r.id),
  kind: r.kind as ProviderKind,
  adapter: isAiAdapterId(r.adapter) ? r.adapter : null,
  name: str(r.name),
  endpoint: str(r.endpoint),
  model: strOrNull(r.model),
  enabled: r.enabled === 1,
  settings: { ...DEFAULT_PROVIDER_SETTINGS, ...parseJson<Partial<ProviderSettings>>(r.settings, {}) },
  createdAt: str(r.created_at),
  updatedAt: str(r.updated_at)
})

const providerParams = (p: ProviderRecord): Params => ({
  id: p.id,
  kind: p.kind,
  adapter: p.adapter,
  name: p.name,
  endpoint: p.endpoint,
  model: p.model,
  enabled: p.enabled,
  settings: JSON.stringify(p.settings),
  created_at: p.createdAt,
  updated_at: p.updatedAt
})

export function providerRepository(db: SqliteDatabase): ProviderRepository {
  return {
    list(kind) {
      const rows = kind
        ? db.all<Row>('SELECT * FROM provider_configs WHERE kind = :kind ORDER BY created_at', { kind })
        : db.all<Row>(
            `SELECT * FROM provider_configs
             ORDER BY CASE kind WHEN 'ixbrowser' THEN 0 WHEN 'openai-compatible' THEN 1 ELSE 2 END, created_at`
          )
      return rows.map(providerFromRow)
    },
    get(id) {
      const row = db.get<Row>('SELECT * FROM provider_configs WHERE id = :id', { id })
      return row ? providerFromRow(row) : null
    },
    insert(record) {
      db.run(
        `INSERT INTO provider_configs (id, kind, adapter, name, endpoint, model, enabled, settings, created_at, updated_at)
         VALUES (:id, :kind, :adapter, :name, :endpoint, :model, :enabled, :settings, :created_at, :updated_at)`,
        providerParams(record)
      )
    },
    update(record) {
      db.run(
        `UPDATE provider_configs SET name = :name, endpoint = :endpoint, model = :model, enabled = :enabled,
           settings = :settings, updated_at = :updated_at
         WHERE id = :id AND kind = :kind`,
        {
          id: record.id,
          kind: record.kind,
          name: record.name,
          endpoint: record.endpoint,
          model: record.model,
          enabled: record.enabled,
          settings: JSON.stringify(record.settings),
          updated_at: record.updatedAt
        }
      )
    },
    remove(id) {
      return db.run('DELETE FROM provider_configs WHERE id = :id', { id }).changes > 0
    }
  }
}

const refFromRow = (r: Row): CredentialRefRecord => ({
  id: str(r.id),
  providerId: str(r.provider_id),
  vaultKey: str(r.vault_key),
  hint: strOrNull(r.hint),
  createdAt: str(r.created_at),
  updatedAt: str(r.updated_at)
})

export function credentialRefRepository(db: SqliteDatabase): CredentialRefRepository {
  return {
    all: () => db.all<Row>('SELECT * FROM credential_refs').map(refFromRow),
    forProvider(providerId) {
      const row = db.get<Row>('SELECT * FROM credential_refs WHERE provider_id = :providerId', { providerId })
      return row ? refFromRow(row) : null
    },
    upsert(record) {
      db.run(
        `INSERT INTO credential_refs (id, provider_id, vault_key, hint, created_at, updated_at)
         VALUES (:id, :providerId, :vaultKey, :hint, :createdAt, :updatedAt)
         ON CONFLICT(provider_id) DO UPDATE SET vault_key = excluded.vault_key, hint = excluded.hint, updated_at = excluded.updated_at`,
        { ...record }
      )
    },
    removeForProvider(providerId) {
      db.run('DELETE FROM credential_refs WHERE provider_id = :providerId', { providerId })
    },
    clear: () => db.run('DELETE FROM credential_refs').changes
  }
}

export function logRepository(db: SqliteDatabase): LogRepository {
  return {
    insert(entry) {
      return db.run('INSERT INTO logs (at, level, scope, message, meta) VALUES (:at, :level, :scope, :message, :meta)', {
        at: entry.at,
        level: entry.level,
        scope: entry.scope,
        message: entry.message,
        meta: entry.meta ? JSON.stringify(entry.meta) : null
      }).lastInsertRowid
    },
    query({ levels, search, limit = 500 }) {
      const where: string[] = []
      const params: Params = { limit: Math.min(Math.max(limit, 1), 5000) }
      if (levels?.length) {
        where.push(`level IN (${levels.map((_, i) => `:l${i}`).join(', ')})`)
        levels.forEach((level, i) => (params[`l${i}`] = level))
      }
      if (search?.trim()) {
        where.push("(message LIKE :search ESCAPE '\\' OR scope LIKE :search ESCAPE '\\')")
        params.search = `%${search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
      }
      const sql = `SELECT * FROM logs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT :limit`
      return db.all<Row>(sql, params).map(
        (r): LogEntry => ({
          id: Number(r.id),
          at: str(r.at),
          level: r.level as LogEntry['level'],
          scope: str(r.scope),
          message: str(r.message),
          meta: parseJson<LogMeta | null>(r.meta, null)
        })
      )
    },
    clear: () => db.run('DELETE FROM logs').changes,
    pruneBefore: (iso) => db.run('DELETE FROM logs WHERE at < :iso', { iso }).changes
  }
}
