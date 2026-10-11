import type { PublishResult, TaskKind, TaskStatus } from '@shared/types/domain'
import type { TaskRecord } from '../database/sqlite/queueRepository'

/**
 * How a failed attempt should be treated:
 *  - retry:  nothing happened (e.g. the profile could not open) — safe to try again
 *  - fail:   a definite failure — do not retry
 *  - review: it may already have taken effect — never retried automatically
 */
export type Disposition = 'retry' | 'fail' | 'review'

/** A task failure with a plain-language message (shown to the user as-is). */
export class TaskError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly disposition: Disposition
  ) {
    super(message)
    this.name = 'TaskError'
  }
}

export interface TaskContext {
  /** Aborted when the user cancels or the app quits. Handlers check it between steps. */
  signal: AbortSignal
  attempt: number
  /** Records the step the attempt has reached (shown in the queue). */
  stage(stage: string): void
}

export interface TaskSettlement {
  /** 'queued' = put back for a safe retry. */
  status: Exclude<TaskStatus, 'running'>
  result: PublishResult | null
  errorCode: string | null
  error: string | null
}

/** A unit of work the queue knows how to run, registered per task kind. */
export interface TaskHandler {
  readonly kind: TaskKind
  /** False when running it twice could repeat a side effect (publishing). */
  readonly idempotent: boolean
  run(task: TaskRecord, context: TaskContext): Promise<PublishResult | null>
  /** Earliest time the task may start (e.g. spacing between posts); null = now. */
  notBefore?(task: TaskRecord, now: Date): string | null
  /** Runs in the same transaction that records the outcome, for related records. */
  settle?(task: TaskRecord, settlement: TaskSettlement): void
  /** Plain-language label for a progress stage. */
  stageLabel?(stage: string): string
}
