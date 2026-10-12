import type { Id, PublishResult, ScheduledPost, Task, Timestamp } from './domain'

/** Publishing preferences (Settings → Publishing). Stored in app_settings. */
export interface PublishingSettings {
  /** Minimum minutes between two posts from the same account. 0 = no spacing. */
  spacingMinutes: number
  /**
   * A slot missed by up to this many minutes (app closed, computer asleep) is
   * still published when the app is back. Older slots wait for the user.
   */
  missedGraceMinutes: number
  /** Remind this many minutes before a scheduled post goes out. 0 = no reminder. */
  reminderMinutes: number
  /** Close the profile after publishing — only when X Auto opened it. */
  closeProfileAfterPublish: boolean
  /**
   * Attempts for failures that happened before anything was submitted
   * (profile could not open, engine not reachable). Uncertain outcomes are
   * never retried.
   */
  maxAttempts: number
  /** Wait before the first safe retry; each further retry waits five times longer (at most an hour). */
  retryDelayMinutes: number
}

export const DEFAULT_PUBLISHING_SETTINGS: PublishingSettings = {
  spacingMinutes: 10,
  missedGraceMinutes: 15,
  reminderMinutes: 10,
  closeProfileAfterPublish: true,
  maxAttempts: 3,
  retryDelayMinutes: 1
}

export const PUBLISHING_LIMITS = {
  spacingMinutes: [0, 1440],
  missedGraceMinutes: [0, 1440],
  reminderMinutes: [0, 1440],
  maxAttempts: [1, 5],
  retryDelayMinutes: [1, 60]
} as const

/** Delay before safe retry number `attempt` (1-based). */
export const retryDelayMs = (settings: Pick<PublishingSettings, 'retryDelayMinutes'>, attempt: number) =>
  Math.min(settings.retryDelayMinutes * 5 ** Math.max(attempt - 1, 0), 60) * 60_000

export interface PublishProblem {
  code:
    | 'no-account'
    | 'account-missing'
    | 'account-disabled'
    | 'not-linked'
    | 'profile-unavailable'
    | 'empty'
    | 'too-long'
    | 'media-missing'
    | 'media-invalid'
    | 'alt-text'
    | 'premium-length'
    | 'handle-unknown'
    | 'already-scheduled'
    | 'already-published'
    | 'spacing'
    | 'in-past'
    | 'comment-empty'
    | 'comment-too-long'
    | 'comment-length'
    | 'no-eligible'
  message: string
  /** False = a warning the user can accept. */
  blocking: boolean
}

export interface PublishCheck {
  ok: boolean
  problems: PublishProblem[]
}

export interface ScheduleInput {
  draftId: Id
  accountId: Id
  runAt: Timestamp
}

export interface PublishNowInput {
  draftId: Id
  accountId: Id
}

/** One manual post from several accounts: the draft goes to the first, an independent copy to each other. */
export interface MultiScheduleInput {
  draftId: Id
  accountIds: Id[]
  /** null = publish now. */
  runAt: Timestamp | null
  /** The same text from more than one account must be allowed explicitly. */
  allowSameText: boolean
}

/**
 * The accounts a post goes out from: every enabled account whose synced IX Browser profile is
 * available. Decided by the main process — the renderer never picks accounts.
 */
export interface PublishTargets {
  eligible: { accountId: Id; label: string; handle: string | null; identityConfirmed: boolean }[]
  /** Linked accounts that can't post right now, with the reason. */
  unavailable: { accountId: Id; label: string; reason: string }[]
  /** Synced profiles, in any state. */
  profiles: number
}

/** Publish (runAt null) or schedule one saved post from every eligible account. */
export interface PublishAllInput {
  draftId: Id
  runAt: Timestamp | null
  /** Needed when more than one account would post the same text. */
  allowSameText: boolean
}

export interface PublishAllCheck extends PublishCheck {
  targets: PublishTargets
}

export interface MultiScheduleResult {
  entries: ScheduleEntry[]
  failed: { accountId: Id; reason: string }[]
}

/** A schedule row with what the UI needs to show it. */
export interface ScheduleEntry {
  schedule: ScheduledPost
  draft: { id: Id; preview: string; mediaCount: number; status: string } | null
  account: { id: Id; label: string; handle: string | null } | null
  task: Pick<Task, 'id' | 'status' | 'error' | 'attempts' | 'runAfter'> & { result: PublishResult | null } | null
}

export interface ScheduleQuery {
  /** Inclusive ISO bounds on run_at; omitted = no bound. */
  from?: Timestamp
  to?: Timestamp
  accountId?: Id
  view: 'upcoming' | 'attention' | 'history' | 'all'
}

export type MissedAction = { action: 'publish-now' } | { action: 'reschedule'; runAt: Timestamp } | { action: 'cancel' }

export interface TaskView extends Task {
  accountLabel: string | null
  accountHandle: string | null
  draftPreview: string | null
  /** The step the latest attempt reached, in plain language. */
  stage: string | null
}

export type TaskRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'uncertain'

export interface TaskRunView {
  attempt: number
  status: TaskRunStatus
  /** Last step reached, as a plain-language label. */
  stage: string | null
  startedAt: Timestamp
  finishedAt: Timestamp | null
  error: string | null
}

export interface TaskDetails {
  task: TaskView
  runs: TaskRunView[]
}

export interface QueueQuery {
  view: 'active' | 'attention' | 'done' | 'all'
  limit?: number
}

export interface QueueCounts {
  queued: number
  running: number
  needsReview: number
  failed: number
  /** Queued tasks on hold. */
  held: number
}

/** The automation control centre's view of the queue. */
export interface AutomationSnapshot {
  /** paused: the user paused the queue; running: a task is in progress; idle: nothing to do right now. */
  state: 'running' | 'idle' | 'paused'
  pausedAt: Timestamp | null
  current: (TaskView & { profileName: string | null }) | null
  counts: QueueCounts
  today: { succeeded: number; failed: number }
  next: ScheduleEntry | null
  engine: 'ready' | 'starting' | 'stopped' | 'crashed' | 'failed' | 'unavailable' | 'stopping'
}

export type ReviewResolution = { taskId: Id; outcome: 'posted'; url: string | null } | { taskId: Id; outcome: 'not-posted' }
