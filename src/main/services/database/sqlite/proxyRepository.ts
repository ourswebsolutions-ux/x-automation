import type { ProxyAssignment, ProxyScheme, ProxyTest } from '@shared/types/proxies'
import type { SqliteDatabase } from '../driver'
import { str, strOrNull, type Row } from './tableRepository'

export interface ProxyRow {
  id: string
  label: string
  scheme: ProxyScheme
  host: string
  port: number
  username: string | null
  hasPassword: boolean
  enabled: boolean
  notes: string
  lastTest: ProxyTest | null
  assignedProfiles: number
  createdAt: string
  updatedAt: string
}

const fromRow = (r: Row): ProxyRow => ({
  id: str(r.id),
  label: str(r.label),
  scheme: r.scheme as ProxyScheme,
  host: str(r.host),
  port: Number(r.port),
  username: strOrNull(r.username),
  hasPassword: Number(r.has_password) === 1,
  enabled: Number(r.enabled) === 1,
  notes: str(r.notes),
  lastTest: r.last_test_at
    ? {
        ok: Number(r.last_test_ok) === 1,
        testedAt: str(r.last_test_at),
        latencyMs: r.last_latency_ms === null ? null : Number(r.last_latency_ms),
        error: strOrNull(r.last_error),
        verified: (strOrNull(r.last_verified) as ProxyTest['verified']) ?? null,
        target: str(r.last_target ?? '')
      }
    : null,
  assignedProfiles: Number(r.assigned ?? 0),
  createdAt: str(r.created_at),
  updatedAt: str(r.updated_at)
})

const SELECT = 'SELECT p.*, (SELECT COUNT(*) FROM proxy_assignments a WHERE a.proxy_id = p.id) AS assigned FROM proxies p'

/** Proxies and profile assignments. Passwords are not stored here (see the credential vault). */
export class ProxyRepository {
  constructor(private readonly db: SqliteDatabase) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)
  }

  list(): ProxyRow[] {
    return this.db.all<Row>(`${SELECT} ORDER BY p.label COLLATE NOCASE, p.created_at`).map(fromRow)
  }

  get(id: string): ProxyRow | null {
    const row = this.db.get<Row>(`${SELECT} WHERE p.id = :id`, { id })
    return row ? fromRow(row) : null
  }

  findIdentity(scheme: string, host: string, port: number, username: string | null): ProxyRow | null {
    const row = this.db.get<Row>(`${SELECT} WHERE p.scheme = :scheme AND lower(p.host) = lower(:host) AND p.port = :port AND COALESCE(p.username, '') = :username`, {
      scheme,
      host,
      port,
      username: username ?? ''
    })
    return row ? fromRow(row) : null
  }

  insert(row: Omit<ProxyRow, 'lastTest' | 'assignedProfiles'>): void {
    this.db.run(
      `INSERT INTO proxies (id, label, scheme, host, port, username, has_password, enabled, notes, created_at, updated_at)
       VALUES (:id, :label, :scheme, :host, :port, :username, :hasPassword, :enabled, :notes, :createdAt, :updatedAt)`,
      { ...row }
    )
  }

  update(row: Omit<ProxyRow, 'lastTest' | 'assignedProfiles' | 'createdAt'>, connectionChanged: boolean): void {
    this.db.run(
      `UPDATE proxies SET label = :label, scheme = :scheme, host = :host, port = :port, username = :username, has_password = :hasPassword,
         enabled = :enabled, notes = :notes, updated_at = :updatedAt
         ${connectionChanged ? ', last_test_at = NULL, last_test_ok = NULL, last_latency_ms = NULL, last_error = NULL, last_verified = NULL, last_target = NULL' : ''}
       WHERE id = :id`,
      { ...row }
    )
  }

  saveTest(id: string, test: ProxyTest): void {
    this.db.run(
      `UPDATE proxies SET last_test_at = :at, last_test_ok = :ok, last_latency_ms = :latency, last_error = :error, last_verified = :verified, last_target = :target WHERE id = :id`,
      { id, at: test.testedAt, ok: test.ok, latency: test.latencyMs, error: test.error, verified: test.verified, target: test.target }
    )
  }

  remove(id: string): boolean {
    return this.db.run('DELETE FROM proxies WHERE id = :id', { id }).changes > 0
  }

  assignments(): ProxyAssignment[] {
    return this.db
      .all<Row>(
        `SELECT a.*, b.external_id, b.name AS profile_name, p.label AS proxy_label
         FROM proxy_assignments a JOIN browser_profiles b ON b.id = a.profile_id JOIN proxies p ON p.id = a.proxy_id
         ORDER BY b.name COLLATE NOCASE`
      )
      .map((r) => ({
        profileId: str(r.profile_id),
        externalId: Number(r.external_id),
        profileName: str(r.profile_name),
        proxyId: str(r.proxy_id),
        proxyLabel: str(r.proxy_label),
        status: r.status as ProxyAssignment['status'],
        appliedAt: strOrNull(r.applied_at),
        error: strOrNull(r.error),
        updatedAt: str(r.updated_at)
      }))
  }

  assignmentFor(profileId: string): { proxyId: string; status: string } | null {
    return this.db.get<{ proxyId: string; status: string }>('SELECT proxy_id AS proxyId, status FROM proxy_assignments WHERE profile_id = :profileId', { profileId }) ?? null
  }

  upsertAssignment(profileId: string, proxyId: string, status: 'applied' | 'failed', error: string | null, at: string): void {
    this.db.run(
      `INSERT INTO proxy_assignments (profile_id, proxy_id, status, applied_at, error, updated_at)
       VALUES (:profileId, :proxyId, :status, :appliedAt, :error, :at)
       ON CONFLICT(profile_id) DO UPDATE SET proxy_id = excluded.proxy_id, status = excluded.status,
         applied_at = CASE WHEN excluded.status = 'applied' THEN excluded.applied_at ELSE proxy_assignments.applied_at END,
         error = excluded.error, updated_at = excluded.updated_at`,
      { profileId, proxyId, status, appliedAt: status === 'applied' ? at : null, error, at }
    )
  }

  removeAssignment(profileId: string): boolean {
    return this.db.run('DELETE FROM proxy_assignments WHERE profile_id = :profileId', { profileId }).changes > 0
  }
}
