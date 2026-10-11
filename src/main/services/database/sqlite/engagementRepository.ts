import type { Id } from '@shared/types/domain'
import type { EngagementKind, EngagementQuery, EngagementStatus, EngagementTask, EngagementTaskView, EngagementUpdate } from '@shared/types/links'
import type { SqliteDatabase } from '../driver'
import { str, strOrNull, type Row } from './tableRepository'

const fromRow = (r: Row): EngagementTask => ({
  id: str(r.id),
  linkId: str(r.link_id),
  accountId: strOrNull(r.account_id),
  kind: r.kind as EngagementKind,
  status: r.status as EngagementStatus,
  dueAt: strOrNull(r.due_at),
  note: str(r.note ?? ''),
  replyText: str(r.reply_text ?? ''),
  createdAt: str(r.created_at),
  updatedAt: str(r.updated_at),
  completedAt: strOrNull(r.completed_at)
})

const toView = (r: Row): EngagementTaskView => ({
  ...fromRow(r),
  accountLabel: strOrNull(r.account_label),
  accountHandle: strOrNull(r.account_handle),
  linkUrl: str(r.link_url),
  linkPreview: str(r.link_preview ?? ''),
  linkHandle: strOrNull(r.link_handle)
})

const VIEW_SELECT = `SELECT e.*, a.label AS account_label, a.handle AS account_handle, l.url AS link_url, l.preview AS link_preview, l.handle AS link_handle
  FROM engagement_tasks e JOIN post_links l ON l.id = e.link_id LEFT JOIN accounts a ON a.id = e.account_id`

/** Engagement tasks (a checklist; nothing here acts on X). */
export class EngagementRepository {
  constructor(private readonly db: SqliteDatabase) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)
  }

  insert(task: EngagementTask): void {
    this.db.run(
      `INSERT INTO engagement_tasks (id, link_id, account_id, kind, status, due_at, note, reply_text, created_at, updated_at, completed_at)
       VALUES (:id, :linkId, :accountId, :kind, :status, :dueAt, :note, :replyText, :createdAt, :updatedAt, :completedAt)`,
      { ...task }
    )
  }

  get(id: Id): EngagementTask | null {
    const row = this.db.get<Row>('SELECT * FROM engagement_tasks WHERE id = :id', { id })
    return row ? fromRow(row) : null
  }

  view(id: Id): EngagementTaskView | null {
    const row = this.db.get<Row>(`${VIEW_SELECT} WHERE e.id = :id`, { id })
    return row ? toView(row) : null
  }

  list(query: EngagementQuery): EngagementTaskView[] {
    const where: string[] = []
    const params: Record<string, string> = {}
    if (query.status !== 'all') {
      where.push('e.status = :status')
      params.status = query.status
    }
    if (query.accountId) {
      where.push('e.account_id = :accountId')
      params.accountId = query.accountId
    }
    if (query.linkId) {
      where.push('e.link_id = :linkId')
      params.linkId = query.linkId
    }
    const order = query.status === 'open' ? "CASE WHEN e.due_at IS NULL THEN 1 ELSE 0 END, e.due_at, e.created_at" : 'e.updated_at DESC'
    return this.db.all<Row>(`${VIEW_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT 2000`, params).map(toView)
  }

  /** An open task for the same post, account and kind. */
  openDuplicate(linkId: Id, accountId: Id | null, kind: EngagementKind, excludeId: Id | null = null): EngagementTask | null {
    const row = this.db.get<Row>(
      "SELECT * FROM engagement_tasks WHERE link_id = :linkId AND COALESCE(account_id, '') = :accountId AND kind = :kind AND status = 'open' AND id != :excludeId",
      { linkId, accountId: accountId ?? '', kind, excludeId: excludeId ?? '' }
    )
    return row ? fromRow(row) : null
  }

  /** Accounts (other than `accountId`) with an open or done task of these kinds on the post. */
  otherAccountsWithKinds(linkId: Id, kinds: readonly EngagementKind[], accountId: Id | null, excludeId: Id | null = null): string[] {
    const placeholders = kinds.map((_, i) => `:k${i}`).join(', ')
    const params: Record<string, string> = { linkId, accountId: accountId ?? '', excludeId: excludeId ?? '' }
    kinds.forEach((k, i) => (params[`k${i}`] = k))
    return this.db
      .all<{ account_id: string }>(
        `SELECT DISTINCT account_id FROM engagement_tasks WHERE link_id = :linkId AND kind IN (${placeholders}) AND status IN ('open', 'done')
         AND account_id IS NOT NULL AND account_id != :accountId AND id != :excludeId`,
        params
      )
      .map((r) => r.account_id)
  }

  /** Tasks planned for an account on the local day containing `dayStart`..`dayEnd` (due or created then). */
  countForDay(accountId: Id, dayStart: string, dayEnd: string, excludeId: Id | null = null): number {
    return (
      this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM engagement_tasks WHERE account_id = :accountId AND status != 'skipped' AND id != :excludeId
         AND COALESCE(due_at, created_at) >= :dayStart AND COALESCE(due_at, created_at) < :dayEnd`,
        { accountId, dayStart, dayEnd, excludeId: excludeId ?? '' }
      )?.n ?? 0
    )
  }

  update(id: Id, update: EngagementUpdate, now: string): void {
    this.db.run('UPDATE engagement_tasks SET account_id = :accountId, kind = :kind, due_at = :dueAt, note = :note, reply_text = :replyText, updated_at = :now WHERE id = :id', {
      id,
      ...update,
      now
    })
  }

  setStatus(id: Id, status: EngagementStatus, now: string): boolean {
    return (
      this.db.run('UPDATE engagement_tasks SET status = :status, completed_at = :completedAt, updated_at = :now WHERE id = :id', {
        id,
        status,
        completedAt: status === 'open' ? null : now,
        now
      }).changes === 1
    )
  }

  remove(id: Id): boolean {
    return this.db.run('DELETE FROM engagement_tasks WHERE id = :id', { id }).changes === 1
  }

  counts(): { open: number; overdue: number } {
    const now = new Date().toISOString()
    const row = this.db.get<{ open: number; overdue: number }>(
      "SELECT SUM(status = 'open') AS open, SUM(status = 'open' AND due_at IS NOT NULL AND due_at < :now) AS overdue FROM engagement_tasks",
      { now }
    )
    return { open: Number(row?.open ?? 0), overdue: Number(row?.overdue ?? 0) }
  }
}
