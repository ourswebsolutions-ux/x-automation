import type { Account, AccountDetails, AccountEvent, AccountEventKind, AccountIdentity } from '@shared/types/accounts'
import type { SqliteDatabase } from '../driver'
import { str, strOrNull, type Row } from './tableRepository'

/** Columns written by insert/update. Profile fields come from the join. */
export interface AccountRecord {
  id: string
  label: string
  handle: string | null
  identity: AccountIdentity
  identityConfirmedAt: string | null
  profileId: string | null
  linkedAt: string | null
  enabled: boolean
  notes: string
  createdAt: string
  updatedAt: string
}

const SELECT = `
  SELECT a.*, p.external_id AS p_external_id, p.name AS p_name, p.availability AS p_availability,
         p.run_state AS p_run_state, p.opened_by AS p_opened_by, p.synced_at AS p_synced_at,
         p.status_checked_at AS p_status_checked_at
  FROM accounts a LEFT JOIN browser_profiles p ON p.id = a.browser_profile_id`

const fromRow = (r: Row): Account => ({
  id: str(r.id),
  label: str(r.label),
  handle: strOrNull(r.handle),
  identity: r.identity as AccountIdentity,
  identityConfirmedAt: strOrNull(r.identity_confirmed_at),
  enabled: Number(r.enabled) === 1,
  notes: str(r.notes),
  profile:
    r.browser_profile_id && r.p_external_id !== null && r.p_external_id !== undefined
      ? {
          id: str(r.browser_profile_id),
          externalId: Number(r.p_external_id),
          name: str(r.p_name),
          availability: r.p_availability as 'available' | 'unavailable',
          runState: r.p_run_state as 'running' | 'closed' | 'unknown',
          openedBy: (r.p_opened_by as 'api' | 'client' | null) ?? null,
          lastSyncedAt: str(r.p_synced_at),
          statusCheckedAt: strOrNull(r.p_status_checked_at)
        }
      : null,
  linkedAt: strOrNull(r.linked_at),
  lastActiveAt: strOrNull(r.last_active_at),
  createdAt: str(r.created_at),
  updatedAt: str(r.updated_at)
})

const toParams = (a: AccountRecord) => ({
  id: a.id,
  label: a.label,
  handle: a.handle,
  identity: a.identity,
  identityConfirmedAt: a.identityConfirmedAt,
  profileId: a.profileId,
  linkedAt: a.linkedAt,
  enabled: a.enabled,
  notes: a.notes,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt
})

/** Account records, their profile links and local history (accounts, account_events). */
export class AccountRepository {
  constructor(private readonly db: SqliteDatabase) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)
  }

  list(): Account[] {
    return this.db.all<Row>(`${SELECT} ORDER BY a.label COLLATE NOCASE, a.created_at`).map(fromRow)
  }

  get(id: string): Account | null {
    const row = this.db.get<Row>(`${SELECT} WHERE a.id = :id`, { id })
    return row ? fromRow(row) : null
  }

  byProfile(profileId: string): Account | null {
    const row = this.db.get<Row>(`${SELECT} WHERE a.browser_profile_id = :profileId`, { profileId })
    return row ? fromRow(row) : null
  }

  byHandle(handle: string): Account | null {
    const row = this.db.get<Row>(`${SELECT} WHERE a.handle = :handle`, { handle })
    return row ? fromRow(row) : null
  }

  record(id: string): AccountRecord | null {
    const a = this.get(id)
    return a
      ? {
          id: a.id,
          label: a.label,
          handle: a.handle,
          identity: a.identity,
          identityConfirmedAt: a.identityConfirmedAt,
          profileId: a.profile?.id ?? null,
          linkedAt: a.linkedAt,
          enabled: a.enabled,
          notes: a.notes,
          createdAt: a.createdAt,
          updatedAt: a.updatedAt
        }
      : null
  }

  insert(record: AccountRecord): void {
    this.db.run(
      `INSERT INTO accounts (id, label, handle, identity, identity_confirmed_at, browser_profile_id, linked_at, enabled, notes, created_at, updated_at)
       VALUES (:id, :label, :handle, :identity, :identityConfirmedAt, :profileId, :linkedAt, :enabled, :notes, :createdAt, :updatedAt)`,
      toParams(record)
    )
  }

  update(record: AccountRecord): void {
    this.db.run(
      `UPDATE accounts SET label = :label, handle = :handle, identity = :identity, identity_confirmed_at = :identityConfirmedAt,
         browser_profile_id = :profileId, linked_at = :linkedAt, enabled = :enabled, notes = :notes, updated_at = :updatedAt
       WHERE id = :id`,
      (({ createdAt: _created, ...rest }) => rest)(toParams(record))
    )
  }

  remove(id: string): boolean {
    return this.db.run('DELETE FROM accounts WHERE id = :id', { id }).changes > 0
  }

  touch(id: string, at: string): void {
    this.db.run('UPDATE accounts SET last_active_at = :at WHERE id = :id', { id, at })
  }

  /** Rows in other tables that point at this account. */
  references(id: string): AccountDetails['references'] {
    const n = (table: string) => this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id = :id`, { id })?.n ?? 0
    return { drafts: n('drafts'), scheduled: n('scheduled_posts'), postLinks: n('post_links'), tasks: n('tasks') }
  }

  addEvent(event: AccountEvent): void {
    this.db.run('INSERT INTO account_events (id, account_id, kind, message, at) VALUES (:id, :accountId, :kind, :message, :at)', {
      id: event.id,
      accountId: event.accountId,
      kind: event.kind,
      message: event.message,
      at: event.at
    })
  }

  events(accountId: string, limit: number): AccountEvent[] {
    return this.db
      .all<Row>('SELECT * FROM account_events WHERE account_id = :accountId ORDER BY at DESC, rowid DESC LIMIT :limit', { accountId, limit })
      .map((r) => ({
        id: str(r.id),
        accountId: str(r.account_id),
        kind: r.kind as AccountEventKind,
        message: str(r.message),
        at: str(r.at)
      }))
  }

  pruneEventsBefore(iso: string): number {
    return this.db.run('DELETE FROM account_events WHERE at < :iso', { iso }).changes
  }
}
