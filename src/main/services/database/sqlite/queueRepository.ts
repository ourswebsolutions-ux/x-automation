import type { Id, PublishResult, Task, TaskKind, TaskStatus } from '@shared/types/domain'
import type { QueueCounts, QueueQuery, TaskRunStatus, TaskRunView, TaskView } from '@shared/types/publishing'
import type { SqliteDatabase } from '../driver'
import { str, strOrNull, type Row } from './tableRepository'

export interface TaskInsert {
  id: Id
  kind: TaskKind
  accountId: Id | null
  draftId: Id | null
  scheduleId: Id | null
  label: string
  payload: Record<string, unknown>
  idempotencyKey: string | null
  maxAttempts: number
  runAfter: string
  createdAt: string
}

export interface TaskRecord extends Task {
  payload: Record<string, unknown>
  idempotencyKey: string | null
}

const parseJson = <T>(value: unknown): T | null => {
  if (typeof value !== 'string' || !value) return null
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

const preview = (body: unknown): string | null => {
  if (typeof body !== 'string') return null
  const text = body.trim().replace(/\s+/g, ' ')
  return text.length > 90 ? `${text.slice(0, 90)}…` : text
}

const fromRow = (r: Row): TaskRecord => ({
  id: str(r.id),
  kind: r.kind as TaskKind,
  status: r.status as TaskStatus,
  accountId: strOrNull(r.account_id),
  draftId: strOrNull(r.draft_id),
  scheduleId: strOrNull(r.schedule_id),
  label: str(r.label),
  attempts: Number(r.attempts),
  maxAttempts: Number(r.max_attempts),
  runAfter: str(r.run_after),
  createdAt: str(r.created_at),
  startedAt: strOrNull(r.started_at),
  finishedAt: strOrNull(r.finished_at),
  error: strOrNull(r.error),
  errorCode: strOrNull(r.error_code),
  result: parseJson<PublishResult>(r.result),
  held: Number(r.held ?? 0) === 1,
  payload: parseJson<Record<string, unknown>>(r.payload) ?? {},
  idempotencyKey: strOrNull(r.idempotency_key)
})

const toView = (r: Row): TaskView => {
  const { payload: _payload, idempotencyKey: _key, ...task } = fromRow(r)
  return { ...task, accountLabel: strOrNull(r.account_label), accountHandle: strOrNull(r.account_handle), draftPreview: preview(r.draft_body), stage: strOrNull(r.run_stage) }
}

const VIEW_SELECT = `SELECT t.*, a.label AS account_label, a.handle AS account_handle, d.body AS draft_body,
    (SELECT r.stage FROM task_runs r WHERE r.task_id = t.id ORDER BY r.attempt DESC, r.started_at DESC LIMIT 1) AS run_stage
  FROM tasks t LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN drafts d ON d.id = t.draft_id`

const VIEW_FILTER: Record<QueueQuery['view'], string> = {
  active: "t.status IN ('queued', 'running')",
  attention: "t.status IN ('needs-review', 'failed')",
  done: "t.status IN ('succeeded', 'cancelled')",
  all: '1 = 1'
}

/** The persistent task queue (tasks + task_runs). */
export class QueueRepository {
  constructor(private readonly db: SqliteDatabase) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)
  }

  insert(task: TaskInsert): TaskRecord {
    this.db.run(
      `INSERT INTO tasks (id, kind, status, account_id, draft_id, schedule_id, label, payload, idempotency_key, max_attempts, run_after, created_at, updated_at)
       VALUES (:id, :kind, 'queued', :accountId, :draftId, :scheduleId, :label, :payload, :idempotencyKey, :maxAttempts, :runAfter, :createdAt, :createdAt)`,
      { ...task, payload: JSON.stringify(task.payload) }
    )
    return this.get(task.id)!
  }

  get(id: Id): TaskRecord | null {
    const row = this.db.get<Row>('SELECT * FROM tasks WHERE id = :id', { id })
    return row ? fromRow(row) : null
  }

  view(id: Id): TaskView | null {
    const row = this.db.get<Row>(`${VIEW_SELECT} WHERE t.id = :id`, { id })
    return row ? toView(row) : null
  }

  byIdempotencyKey(key: string): TaskRecord | null {
    const row = this.db.get<Row>('SELECT * FROM tasks WHERE idempotency_key = :key', { key })
    return row ? fromRow(row) : null
  }

  list(query: QueueQuery): TaskView[] {
    const order = query.view === 'active' ? 't.run_after ASC, t.created_at ASC' : 't.updated_at DESC'
    return this.db.all<Row>(`${VIEW_SELECT} WHERE ${VIEW_FILTER[query.view]} ORDER BY ${order} LIMIT :limit`, { limit: query.limit ?? 200 }).map(toView)
  }

  recent(limit: number): TaskView[] {
    return this.db.all<Row>(`${VIEW_SELECT} ORDER BY t.updated_at DESC LIMIT :limit`, { limit }).map(toView)
  }

  counts(): QueueCounts {
    const rows = this.db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status')
    const n = (status: TaskStatus) => Number(rows.find((r) => r.status === status)?.n ?? 0)
    const held = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE status = 'queued' AND held = 1")?.n ?? 0
    return { queued: n('queued'), running: n('running'), needsReview: n('needs-review'), failed: n('failed'), held: Number(held) }
  }

  /** Queued tasks whose time has come, oldest first. */
  runnable(now: string, limit = 25): TaskRecord[] {
    return this.db
      .all<Row>("SELECT * FROM tasks WHERE status = 'queued' AND held = 0 AND run_after <= :now ORDER BY run_after, created_at LIMIT :limit", { now, limit })
      .map(fromRow)
  }

  /** The earliest run_after among queued tasks (to time the next wake-up). */
  nextRunAfter(): string | null {
    return this.db.get<{ at: string | null }>("SELECT MIN(run_after) AS at FROM tasks WHERE status = 'queued' AND held = 0")?.at ?? null
  }

  running(): TaskRecord[] {
    return this.db.all<Row>("SELECT * FROM tasks WHERE status = 'running'").map(fromRow)
  }

  /**
   * Atomically moves a queued task to running. Only one caller can win: the
   * update is conditional on the status still being 'queued'.
   */
  claim(id: Id, now: string): boolean {
    return (
      this.db.run(
        "UPDATE tasks SET status = 'running', attempts = attempts + 1, started_at = :now, error = NULL, error_code = NULL, updated_at = :now WHERE id = :id AND status = 'queued'",
        { id, now }
      ).changes === 1
    )
  }

  finish(id: Id, outcome: { status: Exclude<TaskStatus, 'queued' | 'running'>; errorCode: string | null; error: string | null; result: PublishResult | null }, now: string): void {
    this.db.run(
      `UPDATE tasks SET status = :status, error_code = :errorCode, error = :error, result = :result, finished_at = :now, updated_at = :now WHERE id = :id`,
      { id, now, status: outcome.status, errorCode: outcome.errorCode, error: outcome.error, result: outcome.result ? JSON.stringify(outcome.result) : null }
    )
  }

  /** Puts a task back in the queue (safe retry or interrupted before anything happened). */
  requeue(id: Id, runAfter: string, errorCode: string | null, error: string | null, now: string): void {
    this.db.run(
      "UPDATE tasks SET status = 'queued', run_after = :runAfter, error_code = :errorCode, error = :error, finished_at = NULL, updated_at = :now WHERE id = :id",
      { id, runAfter, errorCode, error, now }
    )
  }

  /** Re-opens a failed task for another round of attempts (user-initiated retry). */
  reopen(id: Id, now: string): boolean {
    return (
      this.db.run(
        "UPDATE tasks SET status = 'queued', attempts = 0, run_after = :now, error = NULL, error_code = NULL, result = NULL, finished_at = NULL, updated_at = :now WHERE id = :id AND status = 'failed'",
        { id, now }
      ).changes === 1
    )
  }

  refundAttempt(id: Id): void {
    this.db.run('UPDATE tasks SET attempts = MAX(attempts - 1, 0) WHERE id = :id', { id })
  }

  /** Puts every waiting publish task of an account on hold; returns how many. */
  holdQueuedForAccount(accountId: Id, now: string): number {
    return this.db.run("UPDATE tasks SET held = 1, updated_at = :now WHERE account_id = :accountId AND kind IN ('publish', 'reply') AND status = 'queued' AND held = 0", { accountId, now }).changes
  }

  /** Holds or releases a waiting task. */
  setHeld(id: Id, held: boolean, now: string): boolean {
    return this.db.run("UPDATE tasks SET held = :held, updated_at = :now WHERE id = :id AND status = 'queued'", { id, held: held ? 1 : 0, now }).changes === 1
  }

  /** Finished tasks today (local day bounds given as ISO). */
  finishedBetween(from: string, to: string): { succeeded: number; failed: number } {
    const row = this.db.get<{ succeeded: number; failed: number }>(
      "SELECT SUM(status = 'succeeded') AS succeeded, SUM(status IN ('failed', 'needs-review')) AS failed FROM tasks WHERE finished_at >= :from AND finished_at < :to",
      { from, to }
    )
    return { succeeded: Number(row?.succeeded ?? 0), failed: Number(row?.failed ?? 0) }
  }

  /** Cancels a task that has not started. */
  cancelQueued(id: Id, now: string): boolean {
    return (
      this.db.run("UPDATE tasks SET status = 'cancelled', finished_at = :now, updated_at = :now WHERE id = :id AND status = 'queued'", { id, now }).changes === 1
    )
  }

  setRunAfter(id: Id, runAfter: string, now: string): void {
    this.db.run("UPDATE tasks SET run_after = :runAfter, updated_at = :now WHERE id = :id AND status = 'queued'", { id, runAfter, now })
  }

  /** Active (queued, running or awaiting review) tasks for a draft. */
  activeForDraft(draftId: Id): TaskRecord[] {
    return this.db.all<Row>("SELECT * FROM tasks WHERE draft_id = :draftId AND status IN ('queued', 'running', 'needs-review')", { draftId }).map(fromRow)
  }

  /**
   * The most recent time this account posted (or may have posted) through the
   * queue — used to keep posts from the same account apart.
   */
  lastPublishAt(accountId: Id): string | null {
    return (
      this.db.get<{ at: string | null }>(
        "SELECT MAX(COALESCE(finished_at, started_at)) AS at FROM tasks WHERE kind = 'publish' AND account_id = :accountId AND status IN ('running', 'succeeded', 'needs-review')",
        { accountId }
      )?.at ?? null
    )
  }

  // ── attempts ──────────────────────────────────────────────────────

  startRun(id: Id, taskId: Id, attempt: number, now: string): void {
    this.db.run("INSERT INTO task_runs (id, task_id, attempt, status, started_at) VALUES (:id, :taskId, :attempt, 'running', :now)", { id, taskId, attempt, now })
  }

  setRunStage(id: Id, stage: string): void {
    this.db.run('UPDATE task_runs SET stage = :stage WHERE id = :id', { id, stage })
  }

  finishRun(id: Id, status: Exclude<TaskRunStatus, 'running'>, errorCode: string | null, error: string | null, now: string): void {
    this.db.run('UPDATE task_runs SET status = :status, error_code = :errorCode, error = :error, finished_at = :now WHERE id = :id', { id, status, errorCode, error, now })
  }

  /** Attempts that were still running when the app stopped. */
  closeOpenRuns(status: Exclude<TaskRunStatus, 'running'>, error: string, now: string): number {
    return this.db.run("UPDATE task_runs SET status = :status, error = :error, finished_at = :now WHERE status = 'running'", { status, error, now }).changes
  }

  runs(taskId: Id): TaskRunView[] {
    return this.db
      .all<Row>('SELECT * FROM task_runs WHERE task_id = :taskId ORDER BY attempt, started_at', { taskId })
      .map((r) => ({
        attempt: Number(r.attempt),
        status: r.status as TaskRunStatus,
        stage: strOrNull(r.stage),
        startedAt: str(r.started_at),
        finishedAt: strOrNull(r.finished_at),
        error: strOrNull(r.error)
      }))
  }
}
