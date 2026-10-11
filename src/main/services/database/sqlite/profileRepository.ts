import type { BrowserProfile, SyncRun } from '@shared/types/ixbrowser'
import type { SqliteDatabase } from '../driver'
import { parseJson, str, strOrNull, type Row } from './tableRepository'

/** A change to an existing profile seen during sync, reported to interested services. */
export interface ProfileChange {
  profileId: string
  externalId: number
  kind: 'renamed' | 'unavailable' | 'restored'
  /** Previous and new name for renames. */
  from?: string
  to?: string
}

export interface ProfileUpsert {
  externalId: number
  name: string
  siteUrl: string | null
  metadata: Record<string, string | number | boolean>
  contentHash: string
}

const fromRow = (r: Row): BrowserProfile => ({
  id: str(r.id),
  externalId: Number(r.external_id),
  name: str(r.name),
  siteUrl: strOrNull(r.site_url),
  availability: r.availability as BrowserProfile['availability'],
  runState: r.run_state as BrowserProfile['runState'],
  openedBy: (r.opened_by as BrowserProfile['openedBy']) ?? null,
  firstSeenAt: str(r.first_seen_at ?? r.synced_at),
  lastSyncedAt: str(r.synced_at),
  statusCheckedAt: strOrNull(r.status_checked_at),
  lastChange: r.last_change as BrowserProfile['lastChange'],
  metadata: parseJson(r.metadata, {})
})

const runFromRow = (r: Row): SyncRun => ({
  id: str(r.id),
  status: r.status as SyncRun['status'],
  startedAt: str(r.started_at),
  finishedAt: strOrNull(r.finished_at),
  discovered: Number(r.discovered),
  added: Number(r.added),
  updated: Number(r.updated),
  unavailable: Number(r.unavailable),
  duplicates: Number(r.duplicates),
  error: strOrNull(r.error)
})

/** Browser profile metadata and sync history (browser_profiles, profile_sync_runs). */
export class ProfileRepository {
  constructor(private readonly db: SqliteDatabase) {}

  list(): BrowserProfile[] {
    return this.db
      .all<Row>("SELECT * FROM browser_profiles ORDER BY availability = 'unavailable', name COLLATE NOCASE")
      .map(fromRow)
  }

  get(id: string): BrowserProfile | null {
    const row = this.db.get<Row>('SELECT * FROM browser_profiles WHERE id = :id', { id })
    return row ? fromRow(row) : null
  }

  getByExternalId(externalId: number): BrowserProfile | null {
    const row = this.db.get<Row>('SELECT * FROM browser_profiles WHERE external_id = :externalId', { externalId: String(externalId) })
    return row ? fromRow(row) : null
  }

  counts() {
    const row = this.db.get<{ total: number; available: number; running: number; unavailable: number }>(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(availability = 'available'), 0) AS available,
              COALESCE(SUM(availability = 'available' AND run_state = 'running'), 0) AS running,
              COALESCE(SUM(availability = 'unavailable'), 0) AS unavailable
       FROM browser_profiles`
    )
    return row ?? { total: 0, available: 0, running: 0, unavailable: 0 }
  }

  /**
   * Applies one sync atomically: inserts new profiles, updates changed ones,
   * and marks profiles that disappeared as unavailable (never deletes them,
   * so accounts linked to a profile keep their link).
   */
  applySync(providerId: string, profiles: ProfileUpsert[], at: string, newId: () => string) {
    return this.db.transaction(() => {
      let added = 0
      let updated = 0
      const changes: ProfileChange[] = []
      const seen = new Set<string>()
      for (const p of profiles) {
        const externalId = String(p.externalId)
        seen.add(externalId)
        const existing = this.db.get<{ id: string; name: string; content_hash: string | null; availability: string }>(
          'SELECT id, name, content_hash, availability FROM browser_profiles WHERE external_id = :externalId',
          { externalId }
        )
        if (!existing) {
          added++
          this.db.run(
            `INSERT INTO browser_profiles (id, external_id, name, site_url, metadata, content_hash, provider_id,
               first_seen_at, synced_at, availability, last_change, run_state)
             VALUES (:id, :externalId, :name, :siteUrl, :metadata, :hash, :providerId, :at, :at, 'available', 'new', 'unknown')`,
            { id: newId(), externalId, name: p.name, siteUrl: p.siteUrl, metadata: JSON.stringify(p.metadata), hash: p.contentHash, providerId, at }
          )
          continue
        }
        const changed = existing.content_hash !== p.contentHash || existing.availability !== 'available'
        if (changed) updated++
        if (existing.availability !== 'available') changes.push({ profileId: existing.id, externalId: p.externalId, kind: 'restored' })
        if (existing.name !== p.name) changes.push({ profileId: existing.id, externalId: p.externalId, kind: 'renamed', from: existing.name, to: p.name })
        this.db.run(
          `UPDATE browser_profiles SET name = :name, site_url = :siteUrl, metadata = :metadata, content_hash = :hash,
             provider_id = :providerId, synced_at = :at, availability = 'available', last_change = :change
           WHERE id = :id`,
          {
            id: existing.id,
            name: p.name,
            siteUrl: p.siteUrl,
            metadata: JSON.stringify(p.metadata),
            hash: p.contentHash,
            providerId,
            at,
            change: changed ? 'updated' : 'unchanged'
          }
        )
      }

      let unavailable = 0
      for (const row of this.db.all<{ id: string; external_id: string }>(
        "SELECT id, external_id FROM browser_profiles WHERE availability = 'available'"
      )) {
        if (seen.has(row.external_id)) continue
        unavailable++
        changes.push({ profileId: row.id, externalId: Number(row.external_id), kind: 'unavailable' })
        this.db.run(
          `UPDATE browser_profiles SET availability = 'unavailable', last_change = 'unavailable', run_state = 'unknown', opened_by = NULL
           WHERE id = :id`,
          { id: row.id }
        )
      }
      return { added, updated, unavailable, changes }
    })
  }

  /** Records run state from the opened-profile lists for every available profile. */
  applyRunState(openedByApi: Set<number>, openedByClient: Set<number> | null, at: string): void {
    this.db.transaction(() => {
      for (const row of this.db.all<{ id: string; external_id: string }>(
        "SELECT id, external_id FROM browser_profiles WHERE availability = 'available'"
      )) {
        const id = Number(row.external_id)
        const byApi = openedByApi.has(id)
        const byClient = openedByClient?.has(id) ?? false
        this.db.run('UPDATE browser_profiles SET run_state = :state, opened_by = :by, status_checked_at = :at WHERE id = :id', {
          id: row.id,
          state: byApi || byClient ? 'running' : 'closed',
          by: byApi ? 'api' : byClient ? 'client' : null,
          at
        })
      }
    })
  }

  setRunState(externalId: number, state: BrowserProfile['runState'], openedBy: BrowserProfile['openedBy'], at: string): void {
    this.db.run('UPDATE browser_profiles SET run_state = :state, opened_by = :openedBy, status_checked_at = :at WHERE external_id = :externalId', {
      externalId: String(externalId),
      state,
      openedBy,
      at
    })
  }

  startRun(id: string, providerId: string, at: string): void {
    this.db.run("INSERT INTO profile_sync_runs (id, provider_id, status, started_at) VALUES (:id, :providerId, 'running', :at)", {
      id,
      providerId,
      at
    })
  }

  finishRun(run: Omit<SyncRun, 'startedAt'>): void {
    this.db.run(
      `UPDATE profile_sync_runs SET status = :status, finished_at = :finishedAt, discovered = :discovered, added = :added,
         updated = :updated, unavailable = :unavailable, duplicates = :duplicates, error = :error WHERE id = :id`,
      {
        id: run.id,
        status: run.status,
        finishedAt: run.finishedAt,
        discovered: run.discovered,
        added: run.added,
        updated: run.updated,
        unavailable: run.unavailable,
        duplicates: run.duplicates,
        error: run.error
      }
    )
  }

  /** Closes runs left "running" by a crash or forced quit. */
  closeStaleRuns(at: string): number {
    return this.db.run(
      "UPDATE profile_sync_runs SET status = 'failed', finished_at = :at, error = 'Interrupted — the app closed during sync.' WHERE status = 'running'",
      { at }
    ).changes
  }

  runs(limit = 10): SyncRun[] {
    return this.db.all<Row>('SELECT * FROM profile_sync_runs ORDER BY started_at DESC LIMIT :limit', { limit }).map(runFromRow)
  }

  lastSuccessfulRun(): SyncRun | null {
    const row = this.db.get<Row>("SELECT * FROM profile_sync_runs WHERE status = 'succeeded' ORDER BY started_at DESC LIMIT 1")
    return row ? runFromRow(row) : null
  }
}
