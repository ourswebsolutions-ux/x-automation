import { randomUUID } from 'node:crypto'
import type { Id, PublishResult, TaskKind } from '@shared/types/domain'
import type { QueueCounts, QueueQuery, TaskDetails, TaskRunStatus, TaskView } from '@shared/types/publishing'
import type { SettingsRepository } from '../database/repositories'
import type { QueueRepository, TaskInsert, TaskRecord } from '../database/sqlite/queueRepository'
import { ConflictError, NotFoundError } from '../errors'
import type { ScopedLogger } from '../logging/logger'
import { TaskError, type TaskHandler, type TaskSettlement } from './types'

interface Deps {
  repo: QueueRepository
  /** Where the paused state is kept (survives restarts). */
  settings?: SettingsRepository
  log: ScopedLogger
  onChange: () => void
  /** Delay before safe retry number n (1-based). */
  backoffMs?: (attempt: number) => number
  /** Tasks running at once (never more than one per account). */
  concurrency?: number
  now?: () => Date
}

export type EnqueueInput = Omit<TaskInsert, 'id' | 'createdAt' | 'runAfter' | 'maxAttempts'> & { runAfter?: string; maxAttempts?: number }

interface ActiveTask {
  controller: AbortController
  accountId: Id | null
  cancelRequested: boolean
  /** Stopped by "Stop now": put back in the (paused) queue rather than cancelled. */
  stopRequested: boolean
  done: Promise<void>
}

const DEFAULT_BACKOFF = [60_000, 5 * 60_000, 15 * 60_000]
const PAUSED_KEY = 'automation.paused'
const INTERRUPTED_MESSAGE = 'Axora Relay closed while this was running, so its outcome is unknown. Check X before trying again.'

/**
 * Persistent task queue. Tasks live in SQLite and survive restarts. A task is
 * claimed with a conditional UPDATE, so it can never run twice at once; one
 * task per account runs at a time. Only failures a handler marks as safe
 * ('retry') are retried, with backoff. Anything that may already have taken
 * effect becomes 'needs-review' and waits for the user.
 */
export class QueueService {
  private readonly handlers = new Map<TaskKind, TaskHandler>()
  private readonly active = new Map<Id, ActiveTask>()
  private readonly settledListeners = new Set<(task: TaskRecord, settlement: TaskSettlement) => void>()
  private timer: NodeJS.Timeout | null = null
  private started = false
  private stopping = false
  private ticking = false
  private pausedAt: string | null = null

  constructor(private readonly deps: Deps) {
    this.pausedAt = deps.settings?.get<{ at: string }>(PAUSED_KEY)?.at ?? null
  }

  // ── automation controls ──────────────────────────────────────────────────

  /** Re-reads the paused state (after a restore replaced the settings). */
  reloadState(): void {
    this.pausedAt = this.deps.settings?.get<{ at: string }>(PAUSED_KEY)?.at ?? null
  }

  get paused(): boolean {
    return this.pausedAt !== null
  }

  get pausedSince(): string | null {
    return this.pausedAt
  }

  /** No new task starts until resumed; a running task finishes normally. Kept across restarts. */
  pause(): void {
    if (this.pausedAt) return
    this.pausedAt = this.now().toISOString()
    this.deps.settings?.set(PAUSED_KEY, { at: this.pausedAt })
    this.deps.log.info('Automation paused')
    this.deps.onChange()
  }

  resume(): void {
    if (!this.pausedAt) return
    this.pausedAt = null
    this.deps.settings?.delete(PAUSED_KEY)
    this.deps.log.info('Automation resumed')
    this.deps.onChange()
    this.kick()
  }

  /** Pauses, and asks running tasks to stop at their next safe point. */
  stopNow(): number {
    this.pause()
    for (const task of this.active.values()) {
      task.stopRequested = true
      task.controller.abort()
    }
    return this.active.size
  }

  /** Keeps a waiting task in the queue without starting it, or releases it. */
  setHeld(id: Id, held: boolean): void {
    const task = this.deps.repo.get(id)
    if (!task) throw new NotFoundError('That task no longer exists.')
    if (task.status !== 'queued' || this.active.has(id)) throw new ConflictError(held ? 'Only waiting tasks can be put on hold.' : 'This task is not on hold.')
    this.deps.repo.setHeld(id, held, this.now().toISOString())
    this.deps.log.info(`${held ? 'Held' : 'Released'} task ${id.slice(0, 8)}`)
    this.deps.onChange()
    if (!held) this.kick()
  }

  /** The task currently running (one at a time by default). */
  current(): TaskRecord | null {
    const id = [...this.active.keys()][0]
    return id ? this.deps.repo.get(id) : null
  }

  finishedBetween(from: string, to: string): { succeeded: number; failed: number } {
    return this.deps.repo.finishedBetween(from, to)
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  register(handler: TaskHandler): void {
    this.handlers.set(handler.kind, handler)
  }

  /** Called after every recorded outcome (outside the transaction). */
  onSettled(listener: (task: TaskRecord, settlement: TaskSettlement) => void): () => void {
    this.settledListeners.add(listener)
    return () => this.settledListeners.delete(listener)
  }

  /** Recovers tasks interrupted by the last shutdown, then starts working. */
  start(): void {
    if (this.started) return
    this.started = true
    this.stopping = false
    this.recover()
    this.kick()
  }

  /** Stops taking new work, asks running tasks to stop, and waits a little for them. */
  async stop(timeoutMs = 8_000): Promise<void> {
    this.stopping = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const task of this.active.values()) task.controller.abort()
    const running = [...this.active.values()].map((t) => t.done)
    if (running.length) await Promise.race([Promise.allSettled(running), new Promise((r) => setTimeout(r, timeoutMs))])
    this.started = false
  }

  get isStarted(): boolean {
    return this.started && !this.stopping
  }

  /** Adds a task. With an idempotency key, the existing task is returned instead of a duplicate. */
  enqueue(input: EnqueueInput): TaskRecord {
    if (input.idempotencyKey) {
      const existing = this.deps.repo.byIdempotencyKey(input.idempotencyKey)
      if (existing) return existing
    }
    const now = this.now().toISOString()
    const task = this.deps.repo.insert({
      ...input,
      id: randomUUID(),
      maxAttempts: input.maxAttempts ?? 3,
      runAfter: input.runAfter ?? now,
      createdAt: now
    })
    this.deps.log.info(`Queued ${task.kind} task ${task.id.slice(0, 8)}`, { runAfter: task.runAfter })
    this.deps.onChange()
    this.kick()
    return task
  }

  list(query: QueueQuery): TaskView[] {
    return this.deps.repo.list(query)
  }

  details(id: Id): TaskDetails {
    const task = this.deps.repo.view(id)
    if (!task) throw new NotFoundError('That task no longer exists.')
    return { task, runs: this.deps.repo.runs(id) }
  }

  counts(): QueueCounts {
    return this.deps.repo.counts()
  }

  recent(limit: number): TaskView[] {
    return this.deps.repo.recent(limit)
  }

  isRunning(id: Id): boolean {
    return this.active.has(id)
  }

  /**
   * Cancels a queued task at once. A running task is asked to stop; it stops
   * only at a safe point (never after a post was submitted).
   */
  cancel(id: Id): 'cancelled' | 'stopping' {
    const task = this.deps.repo.get(id)
    if (!task) throw new NotFoundError('That task no longer exists.')
    const active = this.active.get(id)
    if (active) {
      active.cancelRequested = true
      active.controller.abort()
      return 'stopping'
    }
    if (task.status !== 'queued') throw new ConflictError('Only waiting or running tasks can be cancelled.')
    const handler = this.handlers.get(task.kind)
    const settlement: TaskSettlement = { status: 'cancelled', result: null, errorCode: 'CANCELLED', error: 'Cancelled.' }
    const done = this.deps.repo.transaction(() => {
      if (!this.deps.repo.cancelQueued(id, this.now().toISOString())) return false
      handler?.settle?.(this.deps.repo.get(id)!, settlement)
      return true
    })
    if (!done) throw new ConflictError('The task started before it could be cancelled.')
    this.deps.log.info(`Cancelled task ${id.slice(0, 8)}`)
    this.afterSettle(task, settlement)
    return 'cancelled'
  }

  /** Re-opens a failed task (user decision). Tasks awaiting review must be resolved instead. */
  retry(id: Id, onReopen?: (task: TaskRecord) => void): TaskRecord {
    const task = this.deps.repo.get(id)
    if (!task) throw new NotFoundError('That task no longer exists.')
    if (task.status === 'needs-review') throw new ConflictError('Check whether this already happened first, then mark it as done or not done.')
    if (task.status !== 'failed') throw new ConflictError('Only failed tasks can be retried.')
    this.deps.repo.transaction(() => {
      if (!this.deps.repo.reopen(id, this.now().toISOString())) throw new ConflictError('The task changed before it could be retried.')
      onReopen?.(this.deps.repo.get(id)!)
    })
    this.deps.log.info(`Retrying task ${id.slice(0, 8)}`)
    this.deps.onChange()
    this.kick()
    return this.deps.repo.get(id)!
  }

  /** Records a user's verdict on a task awaiting review. */
  resolve(id: Id, outcome: { status: 'succeeded' | 'failed'; result: PublishResult | null; error: string | null }, related?: (task: TaskRecord) => void): void {
    const task = this.deps.repo.get(id)
    if (!task) throw new NotFoundError('That task no longer exists.')
    if (task.status !== 'needs-review') throw new ConflictError('This task is not waiting for a review.')
    this.deps.repo.transaction(() => {
      this.deps.repo.finish(id, { status: outcome.status, errorCode: outcome.status === 'failed' ? 'NOT_POSTED' : null, error: outcome.error, result: outcome.result }, this.now().toISOString())
      related?.(this.deps.repo.get(id)!)
    })
    this.deps.onChange()
  }

  /** Wakes the worker (after enqueueing, or when something it waits for changed). */
  kick(): void {
    if (!this.started || this.stopping) return
    setImmediate(() => this.tick())
  }

  // ── internals ────────────────────────────────────────────────────────────

  private recover(): void {
    const now = this.now().toISOString()
    for (const task of this.deps.repo.running()) {
      const handler = this.handlers.get(task.kind)
      if (handler?.idempotent) {
        this.deps.repo.requeue(task.id, now, 'INTERRUPTED', null, now)
        this.deps.log.info(`Re-queued interrupted task ${task.id.slice(0, 8)}`)
        continue
      }
      const settlement: TaskSettlement = { status: 'needs-review', result: null, errorCode: 'INTERRUPTED', error: INTERRUPTED_MESSAGE }
      this.deps.repo.transaction(() => {
        this.deps.repo.finish(task.id, { status: 'needs-review', errorCode: 'INTERRUPTED', error: INTERRUPTED_MESSAGE, result: null }, now)
        handler?.settle?.(this.deps.repo.get(task.id)!, settlement)
      })
      this.deps.log.warn(`Task ${task.id.slice(0, 8)} was interrupted by a shutdown; marked for review`, { kind: task.kind })
      this.afterSettle(task, settlement)
    }
    this.deps.repo.closeOpenRuns('uncertain', 'Interrupted when Axora Relay closed.', now)
  }

  private tick(): void {
    if (this.ticking || !this.started || this.stopping || this.paused) return
    this.ticking = true
    try {
      const concurrency = this.deps.concurrency ?? 1
      while (this.active.size < concurrency && this.launchNext()) {
        // keep filling free slots
      }
    } catch (error) {
      this.deps.log.error('The task queue hit an error', error)
    } finally {
      this.ticking = false
      this.scheduleWake()
    }
  }

  private launchNext(): boolean {
    const now = this.now()
    const busy = new Set([...this.active.values()].map((t) => t.accountId).filter(Boolean))
    for (const task of this.deps.repo.runnable(now.toISOString())) {
      if (this.active.has(task.id) || (task.accountId && busy.has(task.accountId))) continue
      const handler = this.handlers.get(task.kind)
      if (!handler) continue // a later phase registers it
      const notBefore = handler.notBefore?.(task, now)
      if (notBefore && notBefore > now.toISOString()) {
        this.deps.repo.setRunAfter(task.id, notBefore, now.toISOString())
        continue
      }
      if (!this.deps.repo.claim(task.id, now.toISOString())) continue
      this.launch(this.deps.repo.get(task.id)!, handler)
      return true
    }
    return false
  }

  private scheduleWake(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.started || this.stopping || this.paused) return
    const next = this.deps.repo.nextRunAfter()
    const delay = next ? Math.min(Math.max(new Date(next).getTime() - this.now().getTime(), 250), 60_000) : 60_000
    this.timer = setTimeout(() => this.tick(), delay)
    this.timer.unref?.()
  }

  private launch(task: TaskRecord, handler: TaskHandler): void {
    const controller = new AbortController()
    const runId = randomUUID()
    this.deps.repo.startRun(runId, task.id, task.attempts, this.now().toISOString())
    const entry: ActiveTask = { controller, accountId: task.accountId, cancelRequested: false, stopRequested: false, done: Promise.resolve() }
    this.active.set(task.id, entry)
    this.deps.log.info(`Started ${task.kind} task ${task.id.slice(0, 8)} (attempt ${task.attempts} of ${task.maxAttempts})`)
    this.deps.onChange()
    entry.done = this.execute(task, handler, runId, entry).finally(() => {
      this.active.delete(task.id)
      this.deps.onChange()
      this.kick()
    })
  }

  private async execute(task: TaskRecord, handler: TaskHandler, runId: string, entry: ActiveTask): Promise<void> {
    const context = {
      signal: entry.controller.signal,
      attempt: task.attempts,
      stage: (stage: string) => {
        this.deps.repo.setRunStage(runId, handler.stageLabel?.(stage) ?? stage)
        this.deps.onChange()
      }
    }
    try {
      const result = await handler.run(task, context)
      this.record(task, handler, runId, 'succeeded', { status: 'succeeded', result, errorCode: null, error: null })
    } catch (raw) {
      const error =
        raw instanceof TaskError
          ? raw
          : handler.idempotent
            ? new TaskError('UNEXPECTED', 'The task stopped because of an unexpected problem.', 'retry')
            : new TaskError('UNEXPECTED', 'The task stopped because of an unexpected problem, so its outcome is unknown. Check before trying again.', 'review')
      if (!(raw instanceof TaskError)) this.deps.log.error(`Task ${task.id.slice(0, 8)} failed unexpectedly`, raw)
      const base = { result: null, errorCode: error.code, error: error.message }
      if (error.disposition === 'review') {
        this.record(task, handler, runId, 'uncertain', { status: 'needs-review', ...base })
      } else if (error.disposition === 'retry' && entry.cancelRequested) {
        this.record(task, handler, runId, 'cancelled', { status: 'cancelled', ...base, errorCode: 'CANCELLED', error: 'Cancelled before anything was posted.' })
      } else if (error.disposition === 'retry' && (this.stopping || entry.stopRequested)) {
        // Quitting or "Stop now": put it back untouched; it runs again when automation resumes.
        // The interrupted attempt does not count against the task's attempts.
        this.deps.repo.refundAttempt(task.id)
        this.record(task, handler, runId, 'cancelled', { status: 'queued', ...base }, this.now().toISOString())
      } else if (error.disposition === 'retry' && task.attempts < task.maxAttempts) {
        const delay = this.deps.backoffMs?.(task.attempts) ?? DEFAULT_BACKOFF[Math.min(task.attempts - 1, DEFAULT_BACKOFF.length - 1)]!
        this.record(task, handler, runId, 'failed', { status: 'queued', ...base }, new Date(this.now().getTime() + delay).toISOString())
      } else {
        this.record(task, handler, runId, 'failed', { status: 'failed', ...base })
      }
    }
  }

  private record(task: TaskRecord, handler: TaskHandler, runId: string, runStatus: Exclude<TaskRunStatus, 'running'>, settlement: TaskSettlement, retryAt?: string): void {
    const now = this.now().toISOString()
    this.deps.repo.transaction(() => {
      this.deps.repo.finishRun(runId, runStatus, settlement.errorCode, settlement.error, now)
      if (settlement.status === 'queued') this.deps.repo.requeue(task.id, retryAt ?? now, settlement.errorCode, settlement.error, now)
      else this.deps.repo.finish(task.id, { status: settlement.status, errorCode: settlement.errorCode, error: settlement.error, result: settlement.result }, now)
      handler.settle?.(this.deps.repo.get(task.id)!, settlement)
    })
    const level = settlement.status === 'succeeded' ? 'success' : settlement.status === 'needs-review' || settlement.status === 'failed' ? 'warn' : 'info'
    this.deps.log[level](`Task ${task.id.slice(0, 8)} ${settlement.status === 'queued' ? `will retry at ${retryAt ?? now}` : settlement.status}`, {
      kind: task.kind,
      code: settlement.errorCode
    })
    this.afterSettle(task, settlement)
  }

  private afterSettle(task: TaskRecord, settlement: TaskSettlement): void {
    this.deps.onChange()
    const fresh = this.deps.repo.get(task.id) ?? task
    for (const listener of this.settledListeners) {
      try {
        listener(fresh, settlement)
      } catch (error) {
        this.deps.log.error('A task listener failed', error)
      }
    }
  }
}
