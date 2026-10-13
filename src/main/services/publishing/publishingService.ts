import { randomUUID } from 'node:crypto'
import { composePost, LENGTH_PROFILES } from '@shared/config/postLimits'
import { measurePost } from '@shared/lib/postLength'
import type { Draft, DraftStatus, Id, PublishResult, ScheduledPost } from '@shared/types/domain'
import {
  DEFAULT_PUBLISHING_SETTINGS,
  PUBLISHING_LIMITS,
  type MissedAction,
  type PublishCheck,
  type PublishAllCheck,
  type PublishAllInput,
  type PublishTargets,
  type MultiScheduleInput,
  type MultiScheduleResult,
  type PublishNowInput,
  type PublishProblem,
  type PublishingSettings,
  type ReviewResolution,
  type ScheduleEntry,
  type ScheduleInput,
  type ScheduleQuery
} from '@shared/types/publishing'
import type { SqliteDatabase } from '../database/driver'
import type { ActivityRepository, Repository, SettingsRepository } from '../database/repositories'
import type { AccountRepository } from '../database/sqlite/accountRepository'
import type { PostLinkRepository } from '../database/sqlite/postLinkRepository'
import type { ScheduleRepository } from '../database/sqlite/scheduleRepository'
import { ConflictError, NotFoundError, ValidationError } from '../errors'
import type { ScopedLogger } from '../logging/logger'
import type { Notifier } from '../notifications/notifier'
import type { QueueService } from '../queue/queueService'
import type { QueueRepository, TaskRecord } from '../database/sqlite/queueRepository'
import type { TaskSettlement } from '../queue/types'
import { commentProblems } from '@shared/lib/postComment'
import { isReplyPayload, type ReplyPayload } from './publishHandler'
import { parsePostUrl } from './postUrl'

const SETTINGS_KEY = 'publishing.settings'
/** A schedule may be set up to a year ahead. */
const MAX_AHEAD_MS = 366 * 86_400_000

interface Deps {
  db: SqliteDatabase
  drafts: Repository<Draft>
  accounts: AccountRepository
  schedules: ScheduleRepository
  postLinks: PostLinkRepository
  queue: QueueService
  /** Copies a draft (with its images) for posting the same text from another account. */
  duplicateDraft?: (id: Id) => Promise<Draft>
  /** For holding an account's waiting posts when its profile is signed out. */
  queueRepo?: QueueRepository
  settings: SettingsRepository
  activity: ActivityRepository
  notifier: Notifier
  log: ScopedLogger
  onChange: () => void
  now?: () => Date
}

const ACTIVE: ScheduledPost['status'][] = ['pending', 'queued', 'missed', 'needs-review']
/** Publishing to every eligible account at once is capped (each account gets its own post and task). */
const MAX_ALL_ACCOUNTS = 200

const time = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })

/**
 * Scheduling and publishing workflow. A schedule turns a draft into a planned
 * post for one account; when it falls due the scheduler hands it to the task
 * queue, whose publish handler posts it through the account's IX Browser
 * profile. Drafts are locked (status "scheduled") while a schedule is active.
 */
export class PublishingService {
  private readonly heldForAccount = new Map<string, number>()

  constructor(private readonly deps: Deps) {
    deps.queue.onSettled((task, settlement) => this.onTaskSettled(task, settlement))
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  // ── settings ─────────────────────────────────────────────────────────────

  getSettings(): PublishingSettings {
    return { ...DEFAULT_PUBLISHING_SETTINGS, ...(this.deps.settings.get<Partial<PublishingSettings>>(SETTINGS_KEY) ?? {}) }
  }

  updateSettings(patch: Partial<PublishingSettings>): PublishingSettings {
    const next = { ...this.getSettings(), ...patch }
    for (const [key, [min, max]] of Object.entries(PUBLISHING_LIMITS) as [keyof typeof PUBLISHING_LIMITS, readonly [number, number]][]) {
      const value = next[key]
      if (!Number.isInteger(value) || value < min || value > max) throw new ValidationError(`${key} must be a whole number between ${min} and ${max}.`)
    }
    this.deps.settings.set(SETTINGS_KEY, next)
    this.deps.log.info('Publishing settings updated', { ...next })
    this.deps.onChange()
    this.deps.queue.kick()
    return next
  }

  // ── checks ───────────────────────────────────────────────────────────────

  /** What stands between this draft and publishing it from this account. */
  async check(draftId: Id, accountId: Id | null, runAt?: string, excludeScheduleId: Id | null = null): Promise<PublishCheck> {
    const draft = await this.deps.drafts.get(draftId)
    if (!draft) throw new NotFoundError('That draft no longer exists.')
    const problems: PublishProblem[] = []
    const add = (code: PublishProblem['code'], message: string, blocking = true) => problems.push({ code, message, blocking })

    if (draft.status === 'published') add('already-published', 'This draft has already been published.')
    const active = this.deps.schedules.activeForDraft(draftId)
    if (active && active.id !== excludeScheduleId) add('already-scheduled', 'This draft is already scheduled. Change or cancel that schedule instead.')

    const text = composePost(draft.body, draft.hashtags)
    if (!text.trim() && !draft.media.length) add('empty', 'The post is empty.')
    const length = measurePost(text, LENGTH_PROFILES.standard.maxWeighted)
    if (length.weighted > LENGTH_PROFILES.premium.maxWeighted) add('too-long', `The post is longer than X allows (${LENGTH_PROFILES.premium.maxWeighted.toLocaleString()} characters).`)
    else if (length.isOver) add('premium-length', 'The post is longer than 280 characters. Only accounts with X Premium can publish it.', false)
    if (draft.media.some((m) => !m.available)) add('media-missing', 'An attached image is missing from the image folder.')
    if (draft.media.some((m) => m.altText.trim())) add('alt-text', 'Image descriptions are not added when publishing yet — the images will go out without them.', false)
    for (const p of commentProblems(draft.comment)) add(p.code, p.message, p.blocking)

    if (!accountId) add('no-account', 'Choose the account to publish from.')
    else {
      const account = this.deps.accounts.get(accountId)
      if (!account) add('account-missing', 'That account no longer exists.')
      else {
        if (!account.enabled) add('account-disabled', `${account.label} is disabled for tasks. Enable it in Synchronized Profiles → X accounts.`)
        if (!account.profile) add('not-linked', `${account.label} is not linked to an IX Browser profile.`)
        else if (account.profile.availability === 'unavailable') add('profile-unavailable', `IX Browser no longer reports the profile linked to ${account.label}.`)
        if (!account.handle || account.identity !== 'confirmed') {
          add('handle-unknown', 'The X username for this account is not confirmed, so X Auto cannot check which account the profile is signed in to before posting.', false)
        }
        if (runAt) {
          const spacing = this.getSettings().spacingMinutes * 60_000
          if (spacing > 0) {
            const at = new Date(runAt).getTime()
            const near = this.deps.schedules.nearby(account.id, new Date(at - spacing).toISOString(), new Date(at + spacing).toISOString(), excludeScheduleId)
            if (near.length) {
              add('spacing', `Another post from ${account.label} is planned at ${time(near[0]!.runAt)}. Posts from one account are kept ${this.getSettings().spacingMinutes} minutes apart, so this one may go out a little later.`, false)
            }
          }
        }
      }
    }
    if (runAt) {
      const at = new Date(runAt).getTime()
      if (Number.isNaN(at)) add('in-past', 'Choose a valid date and time.')
      else if (at < this.now().getTime() - 60_000) add('in-past', 'That time has already passed.')
      else if (at > this.now().getTime() + MAX_AHEAD_MS) add('in-past', 'Schedule posts at most a year ahead.')
    }
    return { ok: !problems.some((p) => p.blocking), problems }
  }

  /** Every account that can post now: enabled, linked to a synced profile IX Browser still reports. */
  targets(): PublishTargets {
    const eligible: PublishTargets['eligible'] = []
    const unavailable: PublishTargets['unavailable'] = []
    for (const account of this.deps.accounts.list()) {
      if (!account.profile) continue
      const reason = !account.enabled ? 'Disabled for tasks' : account.profile.availability !== 'available' ? 'Profile not reported by IX Browser' : null
      if (reason) unavailable.push({ accountId: account.id, label: account.label, reason })
      else eligible.push({ accountId: account.id, label: account.label, handle: account.handle, identityConfirmed: account.identity === 'confirmed' && Boolean(account.handle) })
    }
    const profiles = this.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM browser_profiles')?.n ?? 0
    return { eligible, unavailable, profiles }
  }

  /** The post checked against every eligible account; problems are merged (each message once). */
  async checkAll(draftId: Id, runAt?: string): Promise<PublishAllCheck> {
    const targets = this.targets()
    const problems: PublishProblem[] = []
    const seen = new Set<string>()
    const add = (p: PublishProblem) => {
      if (seen.has(p.message)) return
      seen.add(p.message)
      problems.push(p)
    }
    if (!targets.eligible.length) {
      const check = await this.check(draftId, null, runAt)
      check.problems.filter((p) => p.code !== 'no-account').forEach(add)
      add({
        code: 'no-eligible',
        message: targets.profiles ? 'None of your synchronized profiles can post right now. Sync profiles again, or check their status in Synchronized Profiles.' : 'No profiles are synchronized yet. Sync profiles first in Synchronized Profiles.',
        blocking: true
      })
    } else {
      let unconfirmed = 0
      for (const target of targets.eligible) {
        const check = await this.check(draftId, target.accountId, runAt)
        for (const p of check.problems) {
          if (p.code === 'handle-unknown') unconfirmed++
          else if (p.code === 'spacing' || ['account-missing', 'account-disabled', 'not-linked', 'profile-unavailable'].includes(p.code)) add({ ...p, message: `${target.label}: ${p.message}` })
          else add(p)
        }
      }
      if (unconfirmed) {
        add({
          code: 'handle-unknown',
          message: `${unconfirmed} of ${targets.eligible.length} ${targets.eligible.length === 1 ? 'account has' : 'accounts have'} no confirmed X username, so X Auto posts as whoever is signed in to ${unconfirmed === 1 ? 'that profile' : 'those profiles'} (confirm usernames in Synchronized Profiles → X accounts).`,
          blocking: false
        })
      }
    }
    return { ok: !problems.some((p) => p.blocking), problems, targets }
  }

  /** Publishes now (runAt null) or schedules the post from every eligible account — no account selection. */
  async publishAll(input: PublishAllInput): Promise<MultiScheduleResult> {
    const accountIds = this.targets().eligible.map((t) => t.accountId)
    if (accountIds.length === 0) throw new ValidationError('No synchronized profile can post right now. Sync profiles first.')
    if (accountIds.length > MAX_ALL_ACCOUNTS) throw new ValidationError(`Publishing to more than ${MAX_ALL_ACCOUNTS} accounts at once isn't supported. Disable some accounts for tasks first.`)
    return this.scheduleMany({ draftId: input.draftId, accountIds, runAt: input.runAt, allowSameText: input.allowSameText }, MAX_ALL_ACCOUNTS)
  }

  private async assertPublishable(draftId: Id, accountId: Id, runAt: string, excludeScheduleId: Id | null = null): Promise<void> {
    const check = await this.check(draftId, accountId, runAt, excludeScheduleId)
    const blocking = check.problems.find((p) => p.blocking)
    if (blocking) throw new ValidationError(blocking.message)
  }

  // ── schedules ────────────────────────────────────────────────────────────

  list(query: ScheduleQuery): ScheduleEntry[] {
    return this.deps.schedules.list(query)
  }

  entry(id: Id): ScheduleEntry {
    const entry = this.deps.schedules.entry(id)
    if (!entry) throw new NotFoundError('That schedule no longer exists.')
    return entry
  }

  forDraft(draftId: Id): ScheduleEntry | null {
    return this.deps.schedules.latestForDraft(draftId)
  }

  next(): ScheduleEntry | null {
    return this.deps.schedules.nextPending()
  }

  counts(): { upcoming: number; attention: number } {
    return this.deps.schedules.counts()
  }

  async schedule(input: ScheduleInput): Promise<ScheduleEntry> {
    const runAt = new Date(input.runAt).toISOString()
    await this.assertPublishable(input.draftId, input.accountId, runAt)
    const id = this.createSchedule(input.draftId, input.accountId, runAt)
    this.deps.log.info(`Scheduled draft ${input.draftId.slice(0, 8)} for ${runAt}`)
    await this.activity('Post scheduled', input.draftId)
    this.changed()
    return this.entry(id)
  }

  /** Publishes as soon as the queue can (still one post per account at a time, with spacing). */
  async publishNow(input: PublishNowInput): Promise<ScheduleEntry> {
    const runAt = this.now().toISOString()
    await this.assertPublishable(input.draftId, input.accountId, runAt)
    const id = this.deps.db.transaction(() => {
      const scheduleId = this.createSchedule(input.draftId, input.accountId, runAt)
      this.enqueue(this.deps.schedules.get(scheduleId)!)
      return scheduleId
    })
    this.deps.log.info(`Publish now: draft ${input.draftId.slice(0, 8)}`)
    await this.activity('Post sent to the queue', input.draftId)
    this.changed()
    return this.entry(id)
  }

  /**
   * Schedules (or publishes now) one manual post from several accounts. Every account is checked
   * before anything changes; the draft goes to the first account and an independent copy (same
   * text and images) to each other one, so each post keeps its own schedule, task and link.
   */
  async scheduleMany(input: MultiScheduleInput, maxAccounts = 50): Promise<MultiScheduleResult> {
    const accountIds = [...new Set(input.accountIds)]
    if (accountIds.length === 0) throw new ValidationError('Choose at least one account.')
    if (accountIds.length > maxAccounts) throw new ValidationError(`Choose at most ${maxAccounts} accounts at once.`)
    if (accountIds.length > 1 && !input.allowSameText) {
      throw new ValidationError('Posting the same text from several accounts is off. Turn it on to continue, or choose one account.')
    }
    if (accountIds.length > 1 && !this.deps.duplicateDraft) throw new ValidationError('Posting from several accounts is not available.')
    const runAt = input.runAt ? new Date(input.runAt).toISOString() : this.now().toISOString()
    for (const accountId of accountIds) await this.assertPublishable(input.draftId, accountId, runAt)

    const result: MultiScheduleResult = { entries: [], failed: [] }
    for (const [index, accountId] of accountIds.entries()) {
      try {
        const draftId = index === 0 ? input.draftId : (await this.deps.duplicateDraft!(input.draftId)).id
        const entry = input.runAt ? await this.schedule({ draftId, accountId, runAt }) : await this.publishNow({ draftId, accountId })
        result.entries.push(entry)
      } catch (error) {
        result.failed.push({ accountId, reason: error instanceof Error ? error.message : 'Could not be scheduled.' })
      }
    }
    return result
  }

  async reschedule(id: Id, runAtInput: string): Promise<ScheduleEntry> {
    const schedule = this.requireSchedule(id)
    if (schedule.status === 'needs-review') throw new ConflictError('Check on X whether this post went out first, then resolve it in the queue.')
    if (schedule.status === 'completed' || schedule.status === 'cancelled') throw new ConflictError('This schedule is finished. Schedule the draft again instead.')
    const runAt = new Date(runAtInput).toISOString()
    await this.assertPublishable(schedule.draftId, schedule.accountId, runAt, id)
    this.deps.db.transaction(() => {
      this.cancelWaitingTask(schedule)
      this.deps.schedules.reschedule(id, runAt, this.now().toISOString())
      this.setDraftStatus(schedule.draftId, 'scheduled')
    })
    this.deps.log.info(`Rescheduled ${id.slice(0, 8)} to ${runAt}`)
    this.changed()
    return this.entry(id)
  }

  /** Cancels a schedule and returns the draft to the editable list. */
  async unschedule(id: Id): Promise<void> {
    const schedule = this.requireSchedule(id)
    if (schedule.status === 'needs-review') throw new ConflictError('Check on X whether this post went out first, then resolve it in the queue.')
    if (schedule.status === 'completed') throw new ConflictError('This post was already published.')
    if (schedule.status === 'cancelled') return
    this.deps.db.transaction(() => {
      this.cancelWaitingTask(schedule)
      this.deps.schedules.setStatus(id, 'cancelled', this.now().toISOString())
      this.setDraftStatus(schedule.draftId, 'ready')
    })
    this.deps.log.info(`Unscheduled ${id.slice(0, 8)}`)
    await this.activity('Schedule cancelled', schedule.draftId)
    this.changed()
  }

  /** Lets a failed draft be edited again (cancels its failed schedule). */
  async returnToDrafts(draftId: Id): Promise<void> {
    const draft = await this.deps.drafts.get(draftId)
    if (!draft) throw new NotFoundError('That draft no longer exists.')
    const active = this.deps.schedules.activeForDraft(draftId)
    if (active) return this.unschedule(active.id)
    if (draft.status !== 'failed' && draft.status !== 'scheduled') throw new ConflictError('This draft can already be edited.')
    this.deps.db.transaction(() => {
      this.deps.db.run("UPDATE scheduled_posts SET status = 'cancelled', updated_at = :now WHERE draft_id = :draftId AND status = 'failed'", { draftId, now: this.now().toISOString() })
      this.setDraftStatus(draftId, 'ready')
    })
    this.changed()
  }

  async resolveMissed(id: Id, action: MissedAction): Promise<ScheduleEntry | null> {
    const schedule = this.requireSchedule(id)
    if (schedule.status !== 'missed' && schedule.status !== 'failed') throw new ConflictError('This schedule is not waiting for a decision.')
    if (action.action === 'cancel') {
      await this.unschedule(id)
      return null
    }
    if (action.action === 'reschedule') return this.reschedule(id, action.runAt)
    await this.assertPublishable(schedule.draftId, schedule.accountId, this.now().toISOString(), id)
    this.deps.db.transaction(() => {
      this.deps.schedules.reschedule(id, this.now().toISOString(), this.now().toISOString())
      this.setDraftStatus(schedule.draftId, 'scheduled')
      this.enqueue(this.deps.schedules.get(id)!)
    })
    this.changed()
    return this.entry(id)
  }

  /** Re-opens a failed publish task (user decision). */
  retryTask(taskId: Id): void {
    this.deps.queue.retry(taskId, (task) => {
      // A comment's post is already published: only the comment's own task is reopened.
      if (task.kind === 'reply') return
      if (task.scheduleId) this.deps.schedules.setStatus(task.scheduleId, 'queued', this.now().toISOString())
      if (task.draftId) this.setDraftStatus(task.draftId, 'scheduled')
    })
    this.changed()
  }

  /**
   * The user's verdict on a publish task whose outcome was uncertain:
   * "posted" (optionally with its link) or "not posted".
   */
  resolveReview(resolution: ReviewResolution): void {
    const now = this.now().toISOString()
    // "It was posted" counts only with the post's link: the link is the evidence, and without it a
    // campaign would show the post as published while nothing proves it exists.
    if (resolution.outcome === 'posted') {
      const parsed = resolution.url ? parsePostUrl(resolution.url) : null
      if (!resolution.url?.trim()) throw new ValidationError('Paste the link to the post on X (x.com/<username>/status/<id>). Without it, mark it as not posted and retry.')
      if (!parsed) throw new ValidationError('That is not a link to a post on X (x.com/<username>/status/<id>).')
      const task = this.deps.db.get<{ handle: string | null; identity: string }>('SELECT a.handle, a.identity FROM tasks t LEFT JOIN accounts a ON a.id = t.account_id WHERE t.id = :id', { id: resolution.taskId })
      if (task?.handle && task.identity === 'confirmed' && parsed.handle && parsed.handle.toLowerCase() !== task.handle.toLowerCase()) {
        throw new ValidationError(`That link is to a post by @${parsed.handle}, not @${task.handle}.`)
      }
    }
    const kind = this.deps.db.get<{ kind: string }>('SELECT kind FROM tasks WHERE id = :id', { id: resolution.taskId })?.kind
    if (kind === 'reply') {
      // A comment: only the task's outcome is recorded (the post itself was already confirmed).
      const parsed = resolution.outcome === 'posted' && resolution.url ? parsePostUrl(resolution.url) : null
      if (resolution.outcome === 'posted' && resolution.url && !parsed) throw new ValidationError('That is not a link to a post on X (x.com/<username>/status/<id>).')
      if (resolution.outcome === 'posted') {
        this.deps.queue.resolve(resolution.taskId, { status: 'succeeded', result: { url: parsed?.url ?? null, postId: parsed?.postId ?? null, handle: parsed?.handle ?? null, verifiedBy: 'user' }, error: null })
      } else {
        this.deps.queue.resolve(resolution.taskId, { status: 'failed', result: null, error: 'You confirmed the comment was not posted.' })
      }
      this.deps.log.info(`Comment task ${resolution.taskId.slice(0, 8)} resolved by the user`, { outcome: resolution.outcome })
      return this.changed()
    }
    if (resolution.outcome === 'posted') {
      const parsed = resolution.url ? parsePostUrl(resolution.url) : null
      if (resolution.url && !parsed) throw new ValidationError('That is not a link to a post on X (x.com/<username>/status/<id>).')
      if (parsed && this.deps.postLinks.byUrlOrPostId(parsed.url, parsed.postId)) throw new ConflictError('That post link is already saved.')
      const result: PublishResult = { url: parsed?.url ?? null, postId: parsed?.postId ?? null, handle: parsed?.handle ?? null, verifiedBy: 'user' }
      this.deps.queue.resolve(resolution.taskId, { status: 'succeeded', result, error: null }, (task) => this.markPublished(task, result, now))
      this.deps.log.info(`Task ${resolution.taskId.slice(0, 8)} confirmed as posted by the user`, { link: Boolean(parsed) })
    } else {
      this.deps.queue.resolve(resolution.taskId, { status: 'failed', result: null, error: 'You confirmed it was not posted.' }, (task) => this.markFailed(task, now))
      this.deps.log.info(`Task ${resolution.taskId.slice(0, 8)} confirmed as not posted by the user`)
    }
    this.changed()
  }

  /** Called by the queue's publish handler inside the outcome transaction. */
  settleTask(task: TaskRecord, settlement: TaskSettlement): void {
    const now = this.now().toISOString()
    if (task.kind === 'reply') {
      // A comment never changes its post's schedule or draft; its own task holds the outcome.
      if (settlement.status === 'succeeded' && task.accountId) this.deps.accounts.touch(task.accountId, now)
      return
    }
    switch (settlement.status) {
      case 'succeeded':
        return this.markPublished(task, settlement.result, now)
      case 'failed':
        this.markFailed(task, now)
        // A signed-out profile or the wrong account would fail every following post too: hold them instead.
        if (task.accountId && (settlement.errorCode === 'SESSION_EXPIRED' || settlement.errorCode === 'ACCOUNT_MISMATCH')) {
          const held = this.deps.queueRepo?.holdQueuedForAccount(task.accountId, now) ?? 0
          if (held) this.heldForAccount.set(task.accountId, held)
        }
        return
      case 'needs-review':
        if (task.scheduleId) this.deps.schedules.setStatus(task.scheduleId, 'needs-review', now)
        return
      case 'cancelled':
        if (task.scheduleId) this.deps.schedules.setStatus(task.scheduleId, 'cancelled', now, ['queued', 'pending'])
        if (task.draftId) this.setDraftStatus(task.draftId, 'ready', ['scheduled'])
        return
      default:
        return
    }
  }

  /** Puts a schedule's post in the queue (one task per schedule slot). */
  enqueue(schedule: ScheduledPost): TaskRecord {
    return this.deps.db.transaction(() => {
      const task = this.deps.queue.enqueue({
        kind: 'publish',
        accountId: schedule.accountId,
        draftId: schedule.draftId,
        scheduleId: schedule.id,
        label: 'Publish post',
        payload: {},
        idempotencyKey: `schedule:${schedule.id}:${schedule.runAt}`,
        maxAttempts: this.getSettings().maxAttempts,
        runAfter: schedule.runAt
      })
      this.deps.schedules.setStatus(schedule.id, 'queued', this.now().toISOString(), ['pending', 'missed'])
      return task
    })
  }

  // ── internals ────────────────────────────────────────────────────────────

  private createSchedule(draftId: Id, accountId: Id, runAt: string): Id {
    const now = this.now().toISOString()
    const id = randomUUID()
    this.deps.db.transaction(() => {
      // A failed earlier attempt is closed when the draft is scheduled again.
      this.deps.db.run("UPDATE scheduled_posts SET status = 'cancelled', updated_at = :now WHERE draft_id = :draftId AND status = 'failed'", { draftId, now })
      this.deps.schedules.insert({ id, draftId, accountId, runAt, status: 'pending', remindedAt: null, createdAt: now, updatedAt: now })
      this.deps.db.run("UPDATE drafts SET status = 'scheduled', account_id = :accountId, updated_at = :now WHERE id = :draftId", { draftId, accountId, now })
    })
    return id
  }

  private requireSchedule(id: Id): ScheduledPost {
    const schedule = this.deps.schedules.get(id)
    if (!schedule) throw new NotFoundError('That schedule no longer exists.')
    return schedule
  }

  /** Cancels the schedule's task if it is still waiting; refuses while it runs. */
  private cancelWaitingTask(schedule: ScheduledPost): void {
    if (schedule.status !== 'queued') return
    const task = this.deps.db.get<{ id: string; status: string }>(
      "SELECT id, status FROM tasks WHERE schedule_id = :id AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1",
      { id: schedule.id }
    )
    if (!task) return
    if (task.status === 'running' || this.deps.queue.isRunning(task.id)) throw new ConflictError('This post is being published right now.')
    this.deps.db.run("UPDATE tasks SET status = 'cancelled', finished_at = :now, updated_at = :now WHERE id = :id AND status = 'queued'", { id: task.id, now: this.now().toISOString() })
  }

  /**
   * The comment saved with a post goes out once X confirmed the post: from the same account, as a
   * reply to that post (its id from the confirmed link). One reply task per publish task
   * (idempotency key), created in the same transaction that records the post — so a restart or a
   * retry can never post the comment twice, and a confirmed post never loses its comment.
   */
  private enqueueComment(task: TaskRecord, result: PublishResult | null, now: string): void {
    if (task.kind !== 'publish' || !task.draftId || !task.accountId) return
    const draft = this.deps.db.get<{ comment_enabled: number; comment_text: string }>('SELECT comment_enabled, comment_text FROM drafts WHERE id = :id', { id: task.draftId })
    const text = draft?.comment_enabled === 1 ? draft.comment_text.trim() : ''
    if (!text) return
    if (!result?.postId || !result.url) {
      this.deps.log.warn(`Comment for task ${task.id.slice(0, 8)} not posted: the post link is unknown`)
      this.deps.notifier.notify(
        { tone: 'warning', event: 'taskFailures', title: 'Comment not posted', body: 'The post was confirmed without its link, so X Auto can’t reply to it. Post the comment yourself on X.', to: '/links' },
        { key: `comment-no-link:${task.id}` }
      )
      return
    }
    const payload: ReplyPayload = { parentTaskId: task.id, parentPostId: result.postId, parentUrl: result.url, text }
    this.deps.queue.enqueue({
      kind: 'reply',
      accountId: task.accountId,
      draftId: task.draftId,
      scheduleId: null,
      label: 'Post comment',
      payload: { ...payload },
      idempotencyKey: `reply:${task.id}`,
      maxAttempts: this.getSettings().maxAttempts,
      runAfter: now
    })
  }

  private markPublished(task: TaskRecord, result: PublishResult | null, now: string): void {
    this.enqueueComment(task, result, now)
    if (task.scheduleId) this.deps.schedules.setStatus(task.scheduleId, 'completed', now)
    if (task.draftId) this.setDraftStatus(task.draftId, 'published')
    if (task.accountId) this.deps.accounts.touch(task.accountId, now)
    if (result?.url && !this.deps.postLinks.byUrlOrPostId(result.url, result.postId)) {
      const draft = task.draftId ? this.deps.db.get<{ body: string; hashtags: string }>('SELECT body, hashtags FROM drafts WHERE id = :id', { id: task.draftId }) : undefined
      const text = draft ? composePost(draft.body, JSON.parse(draft.hashtags || '[]') as string[]).trim().replace(/\s+/g, ' ') : ''
      this.deps.postLinks.insert({
        id: randomUUID(),
        url: result.url,
        postId: result.postId,
        handle: result.handle,
        accountId: task.accountId,
        draftId: task.draftId,
        taskId: task.id,
        source: 'published',
        preview: text.length > 140 ? `${text.slice(0, 140)}…` : text,
        publishedAt: now,
        createdAt: now
      })
    }
  }

  private markFailed(task: TaskRecord, now: string): void {
    if (task.scheduleId) this.deps.schedules.setStatus(task.scheduleId, 'failed', now)
    if (task.draftId) this.setDraftStatus(task.draftId, 'failed')
  }

  private setDraftStatus(draftId: Id, status: DraftStatus, onlyFrom?: DraftStatus[]): void {
    const guard = onlyFrom?.length ? ` AND status IN (${onlyFrom.map((s) => `'${s}'`).join(', ')})` : ''
    this.deps.db.run(`UPDATE drafts SET status = :status, updated_at = :now WHERE id = :draftId${guard}`, { draftId, status, now: this.now().toISOString() })
  }

  private onTaskSettled(task: TaskRecord, settlement: TaskSettlement): void {
    if (task.kind === 'reply') return this.onCommentSettled(task, settlement)
    if (task.kind !== 'publish') return
    const account = task.accountId ? this.deps.accounts.get(task.accountId) : null
    const who = account ? (account.handle ? `@${account.handle}` : account.label) : 'the account'
    if (settlement.status === 'succeeded') {
      const seen = settlement.result?.handle
      if (seen && account?.handle && seen.toLowerCase() !== account.handle.toLowerCase()) {
        this.deps.notifier.notify({ tone: 'warning', event: 'taskFailures', title: 'Posted from a different account', body: `The post went out as @${seen}, not ${who}. Check the profile's X sign-in.`, to: '/links' })
      } else {
        this.deps.notifier.notify({ tone: 'success', event: 'systemNotices', title: 'Post published', body: `Published from ${who}.`, to: '/links' })
      }
      this.deps.notifier.clear(`publish-failed:${task.accountId}`)
    } else if (settlement.status === 'needs-review') {
      this.deps.notifier.notify({
        tone: 'warning',
        event: 'taskFailures',
        title: 'Publishing outcome needs review',
        body: `It may have been posted from ${who}. Check X, then confirm in the task queue.`,
        to: '/campaigns?queue=attention'
      })
    } else if (settlement.status === 'failed') {
      const held = task.accountId ? this.heldForAccount.get(task.accountId) : undefined
      if (held && task.accountId) {
        this.heldForAccount.delete(task.accountId)
        this.deps.notifier.notify(
          {
            tone: 'warning',
            event: 'taskFailures',
            title: settlement.errorCode === 'SESSION_EXPIRED' ? `${who} is signed out of X` : `${who}: a different account is signed in`,
            body: `${held} waiting ${held === 1 ? 'post is' : 'posts are'} on hold. Fix the sign-in in IX Browser, then release them in the task queue.`,
            to: '/campaigns?view=queue'
          },
          { key: `account-blocked:${task.accountId}` }
        )
      }
      this.deps.notifier.notify(
        { tone: 'danger', event: 'taskFailures', title: 'A post could not be published', body: settlement.error ?? 'Publishing failed.', to: '/campaigns?queue=attention' },
        { key: `publish-failed:${task.accountId}:${settlement.errorCode}` }
      )
    }
  }

  private onCommentSettled(task: TaskRecord, settlement: TaskSettlement): void {
    const account = task.accountId ? this.deps.accounts.get(task.accountId) : null
    const who = account ? (account.handle ? `@${account.handle}` : account.label) : 'the account'
    const parent = isReplyPayload(task.payload) ? task.payload.parentUrl : null
    if (settlement.status === 'succeeded') {
      this.deps.notifier.notify({ tone: 'success', event: 'systemNotices', title: 'Comment posted', body: `Replied to the post from ${who}.`, to: '/campaigns' }, { key: 'comment-posted', quietMs: 20_000 })
    } else if (settlement.status === 'needs-review') {
      this.deps.notifier.notify({ tone: 'warning', event: 'taskFailures', title: 'Comment outcome needs review', body: `It may have been posted from ${who}${parent ? ` under ${parent}` : ''}. Check X, then confirm it.`, to: '/campaigns?queue=attention' })
    } else if (settlement.status === 'failed') {
      this.deps.notifier.notify(
        { tone: 'danger', event: 'taskFailures', title: 'A comment could not be posted', body: settlement.error ?? 'Posting the comment failed.', to: '/campaigns?queue=attention' },
        { key: `comment-failed:${task.accountId}:${settlement.errorCode}` }
      )
    }
  }

  private changed(): void {
    this.deps.onChange()
    this.deps.queue.kick()
  }

  private async activity(message: string, draftId: Id): Promise<void> {
    const draft = await this.deps.drafts.get(draftId)
    const preview = draft ? draft.body.trim().replace(/\s+/g, ' ') : ''
    await this.deps.activity.append({
      id: randomUUID(),
      level: 'info',
      message,
      subject: preview.length > 48 ? `${preview.slice(0, 48)}…` : preview || null,
      at: this.now().toISOString()
    })
  }
}

export { ACTIVE as ACTIVE_SCHEDULE_STATUSES }
