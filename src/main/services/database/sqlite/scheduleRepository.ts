import type { Id, PublishResult, ScheduledPost, ScheduleStatus, TaskStatus } from '@shared/types/domain'
import type { ScheduleEntry, ScheduleQuery } from '@shared/types/publishing'
import type { SqliteDatabase } from '../driver'
import { str, strOrNull, type Row } from './tableRepository'

const fromRow = (r: Row): ScheduledPost => ({
  id: str(r.id),
  draftId: str(r.draft_id),
  accountId: str(r.account_id),
  runAt: str(r.run_at),
  status: r.status as ScheduleStatus,
  remindedAt: strOrNull(r.reminded_at),
  createdAt: str(r.created_at),
  updatedAt: str(r.updated_at)
})

const preview = (body: unknown): string => {
  const text = typeof body === 'string' ? body.trim().replace(/\s+/g, ' ') : ''
  return text.length > 140 ? `${text.slice(0, 140)}…` : text
}

const parseResult = (value: unknown): PublishResult | null => {
  if (typeof value !== 'string' || !value) return null
  try {
    return JSON.parse(value) as PublishResult
  } catch {
    return null
  }
}

// The task shown for a schedule is its most recent one.
const ENTRY_SELECT = `SELECT s.*,
    d.body AS d_body, d.status AS d_status, (SELECT COUNT(*) FROM draft_attachments da WHERE da.draft_id = d.id) AS d_media,
    a.label AS a_label, a.handle AS a_handle,
    t.id AS t_id, t.status AS t_status, t.error AS t_error, t.attempts AS t_attempts, t.run_after AS t_run_after, t.result AS t_result
  FROM scheduled_posts s
  LEFT JOIN drafts d ON d.id = s.draft_id
  LEFT JOIN accounts a ON a.id = s.account_id
  LEFT JOIN tasks t ON t.id = (SELECT id FROM tasks WHERE schedule_id = s.id ORDER BY created_at DESC LIMIT 1)`

const toEntry = (r: Row): ScheduleEntry => ({
  schedule: fromRow(r),
  draft: r.d_status ? { id: str(r.draft_id), preview: preview(r.d_body), mediaCount: Number(r.d_media ?? 0), status: str(r.d_status) } : null,
  account: r.a_label ? { id: str(r.account_id), label: str(r.a_label), handle: strOrNull(r.a_handle) } : null,
  task: r.t_id
    ? { id: str(r.t_id), status: r.t_status as TaskStatus, error: strOrNull(r.t_error), attempts: Number(r.t_attempts), runAfter: str(r.t_run_after), result: parseResult(r.t_result) }
    : null
})

const VIEW_FILTER: Record<ScheduleQuery['view'], string> = {
  upcoming: "s.status IN ('pending', 'queued')",
  attention: "s.status IN ('missed', 'needs-review', 'failed')",
  history: "s.status IN ('completed', 'cancelled')",
  all: '1 = 1'
}

/** Scheduled posts. */
export class ScheduleRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(schedule: ScheduledPost): void {
    this.db.run(
      `INSERT INTO scheduled_posts (id, draft_id, account_id, run_at, status, reminded_at, created_at, updated_at)
       VALUES (:id, :draftId, :accountId, :runAt, :status, :remindedAt, :createdAt, :updatedAt)`,
      { ...schedule }
    )
  }

  get(id: Id): ScheduledPost | null {
    const row = this.db.get<Row>('SELECT * FROM scheduled_posts WHERE id = :id', { id })
    return row ? fromRow(row) : null
  }

  entry(id: Id): ScheduleEntry | null {
    const row = this.db.get<Row>(`${ENTRY_SELECT} WHERE s.id = :id`, { id })
    return row ? toEntry(row) : null
  }

  list(query: ScheduleQuery): ScheduleEntry[] {
    const where = [VIEW_FILTER[query.view]]
    const params: Record<string, string> = {}
    if (query.from) {
      where.push('s.run_at >= :from')
      params.from = query.from
    }
    if (query.to) {
      where.push('s.run_at <= :to')
      params.to = query.to
    }
    if (query.accountId) {
      where.push('s.account_id = :accountId')
      params.accountId = query.accountId
    }
    const order = query.view === 'history' ? 's.run_at DESC' : 's.run_at ASC'
    return this.db.all<Row>(`${ENTRY_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 500`, params).map(toEntry)
  }

  /** The active schedule of a draft (at most one, enforced by a unique index). */
  activeForDraft(draftId: Id): ScheduledPost | null {
    const row = this.db.get<Row>("SELECT * FROM scheduled_posts WHERE draft_id = :draftId AND status IN ('pending', 'queued', 'missed', 'needs-review')", { draftId })
    return row ? fromRow(row) : null
  }

  /** The most recent schedule of a draft (any status). */
  latestForDraft(draftId: Id): ScheduleEntry | null {
    const row = this.db.get<Row>(`${ENTRY_SELECT} WHERE s.draft_id = :draftId ORDER BY s.created_at DESC LIMIT 1`, { draftId })
    return row ? toEntry(row) : null
  }

  /** Pending schedules whose time has come. */
  due(now: string): ScheduledPost[] {
    return this.db.all<Row>("SELECT * FROM scheduled_posts WHERE status = 'pending' AND run_at <= :now ORDER BY run_at", { now }).map(fromRow)
  }

  /** Pending schedules inside the reminder window that have not been reminded yet. */
  needingReminder(now: string, until: string): ScheduledPost[] {
    return this.db
      .all<Row>("SELECT * FROM scheduled_posts WHERE status = 'pending' AND reminded_at IS NULL AND run_at > :now AND run_at <= :until ORDER BY run_at", { now, until })
      .map(fromRow)
  }

  nextPending(): ScheduleEntry | null {
    const row = this.db.get<Row>(`${ENTRY_SELECT} WHERE s.status = 'pending' ORDER BY s.run_at LIMIT 1`)
    return row ? toEntry(row) : null
  }

  /** Other active slots of this account within ±window of runAt (spacing check). */
  nearby(accountId: Id, from: string, to: string, excludeId: Id | null): ScheduledPost[] {
    return this.db
      .all<Row>(
        "SELECT * FROM scheduled_posts WHERE account_id = :accountId AND status IN ('pending', 'queued') AND run_at BETWEEN :from AND :to AND id != :excludeId ORDER BY run_at",
        { accountId, from, to, excludeId: excludeId ?? '' }
      )
      .map(fromRow)
  }

  setStatus(id: Id, status: ScheduleStatus, now: string, onlyFrom?: ScheduleStatus[]): boolean {
    const guard = onlyFrom?.length ? ` AND status IN (${onlyFrom.map((s) => `'${s}'`).join(', ')})` : ''
    return this.db.run(`UPDATE scheduled_posts SET status = :status, updated_at = :now WHERE id = :id${guard}`, { id, status, now }).changes === 1
  }

  reschedule(id: Id, runAt: string, now: string): void {
    this.db.run("UPDATE scheduled_posts SET run_at = :runAt, status = 'pending', reminded_at = NULL, updated_at = :now WHERE id = :id", { id, runAt, now })
  }

  markReminded(id: Id, now: string): void {
    this.db.run('UPDATE scheduled_posts SET reminded_at = :now WHERE id = :id', { id, now })
  }

  counts(): { upcoming: number; attention: number } {
    const row = this.db.get<{ upcoming: number; attention: number }>(
      "SELECT SUM(status IN ('pending', 'queued')) AS upcoming, SUM(status IN ('missed', 'needs-review', 'failed')) AS attention FROM scheduled_posts"
    )
    return { upcoming: Number(row?.upcoming ?? 0), attention: Number(row?.attention ?? 0) }
  }
}
