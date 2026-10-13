import { composePost } from '@shared/config/postLimits'
import type { Draft, PublishResult } from '@shared/types/domain'
import type { PublishingSettings } from '@shared/types/publishing'
import type { Repository } from '../database/repositories'
import type { AccountRepository } from '../database/sqlite/accountRepository'
import type { PostLinkRepository } from '../database/sqlite/postLinkRepository'
import type { QueueRepository, TaskRecord } from '../database/sqlite/queueRepository'
import { EngineError, type EngineService } from '../engine/engineService'
import { IxBrowserError } from '../integrations/ixbrowser/client'
import type { IxBrowserService } from '../integrations/ixbrowser/ixBrowserService'
import type { ScopedLogger } from '../logging/logger'
import type { Notifier } from '../notifications/notifier'
import { TaskError, type TaskContext, type TaskHandler, type TaskSettlement } from '../queue/types'

interface Deps {
  drafts: Repository<Draft>
  accounts: AccountRepository
  postLinks: PostLinkRepository
  queueRepo: QueueRepository
  ixBrowser: IxBrowserService
  engine: EngineService
  /** Absolute path of a library image, or null when the file is gone. */
  assetFile: (assetId: string) => string | null
  settings: () => PublishingSettings
  /** Writes schedule/draft/link records for an outcome (same transaction). */
  settle: (task: TaskRecord, settlement: TaskSettlement) => void
  log: ScopedLogger
  /** Plain-language notices (e.g. IX Browser unreachable). */
  notifier?: Notifier
  /** Development/test only: a loopback stand-in for x.com. */
  testBaseUrl?: string | null
}

const STAGES: Record<string, string> = {
  validate: 'Checking the post',
  'open-profile': 'Opening the browser profile',
  attach: 'Connecting to the browser',
  'open-composer': 'Opening the X composer',
  write: 'Writing the post',
  'upload-media': 'Adding images',
  submit: 'Posting',
  confirm: 'Confirming on X',
  'check-profile': 'Checking the profile for the post'
}

const REPLY_STAGES: Record<string, string> = {
  ...STAGES,
  validate: 'Checking the comment',
  'open-composer': 'Opening the reply composer',
  write: 'Writing the comment',
  submit: 'Posting the comment',
  'check-profile': 'Checking the profile for the comment'
}

/** What a reply task carries: the post it answers (published by the same account) and the comment. */
export interface ReplyPayload {
  parentTaskId: string
  parentPostId: string
  parentUrl: string
  text: string
}

export const isReplyPayload = (value: Record<string, unknown>): value is Record<string, unknown> & ReplyPayload =>
  typeof value.parentTaskId === 'string' &&
  typeof value.parentPostId === 'string' &&
  /^\d{1,25}$/.test(value.parentPostId) &&
  typeof value.parentUrl === 'string' &&
  typeof value.text === 'string' &&
  value.text.trim().length > 0

/** Stages after which the post may exist. */
const SUBMITTED_STAGES = new Set(['submit', 'confirm'])

interface PublishReply extends Record<string, unknown> {
  url: string
  postId: string
  handle: string
  accountCheck: 'match' | 'unknown' | 'skipped'
  /** post-link: X's notice · profile-check: the engine found it on the signed-in account's profile. */
  verifiedBy?: 'post-link' | 'profile-check'
}

/**
 * Publishes one post through the account's IX Browser profile and the Python
 * engine. Every failure is classified before anything is recorded:
 * failures before the Post button was clicked are safe to retry; once it was
 * clicked, only a confirmed post link counts as success, an explicit refusal
 * by X is a failure, and anything else waits for the user to check X.
 *
 * Registered a second time for 'reply' tasks: the comment saved with a post,
 * posted by the same account as a reply to its own confirmed post, through the
 * same profile, checks and outcome rules.
 */
export class PublishHandler implements TaskHandler {
  readonly idempotent = false

  constructor(
    private readonly deps: Deps,
    readonly kind: 'publish' | 'reply' = 'publish'
  ) {}

  stageLabel(stage: string): string {
    return (this.kind === 'reply' ? REPLY_STAGES : STAGES)[stage] ?? stage
  }

  /** Keeps posts from one account apart by the configured spacing (a comment follows its own post directly). */
  notBefore(task: TaskRecord, now: Date): string | null {
    if (this.kind === 'reply') return null
    const spacing = this.deps.settings().spacingMinutes * 60_000
    if (!task.accountId || spacing <= 0) return null
    const last = this.deps.queueRepo.lastPublishAt(task.accountId)
    if (!last) return null
    const earliest = new Date(last).getTime() + spacing
    return earliest > now.getTime() ? new Date(earliest).toISOString() : null
  }

  settle(task: TaskRecord, settlement: TaskSettlement): void {
    this.deps.settle(task, settlement)
  }

  async run(task: TaskRecord, context: TaskContext): Promise<PublishResult | null> {
    context.stage('validate')
    const reply = this.kind === 'reply' ? task.payload : null
    if (reply && !isReplyPayload(reply)) throw new TaskError('INVALID_COMMENT', 'This comment has no confirmed post to reply to.', 'fail')
    // Never publish twice: a link recorded for this task means it already happened.
    const existing = reply ? null : this.deps.postLinks.byTask(task.id)
    if (existing) return { url: existing.url, postId: existing.postId, handle: existing.handle, verifiedBy: 'post-link' }

    const draft = task.draftId ? await this.deps.drafts.get(task.draftId) : null
    if (!reply && !draft) throw new TaskError('DRAFT_MISSING', 'The draft was deleted, so there is nothing to publish.', 'fail')
    if (!reply && draft!.status === 'published') throw new TaskError('ALREADY_PUBLISHED', 'This draft was already published.', 'fail')
    const account = task.accountId ? this.deps.accounts.get(task.accountId) : null
    if (!account) throw new TaskError('ACCOUNT_MISSING', 'The account for this post no longer exists.', 'fail')
    if (!account.enabled) throw new TaskError('ACCOUNT_DISABLED', `${account.label} is disabled for tasks. Enable it, then retry.`, 'fail')
    if (!account.profile) throw new TaskError('NOT_LINKED', `${account.label} is not linked to an IX Browser profile.`, 'fail')
    if (account.profile.availability === 'unavailable') throw new TaskError('PROFILE_UNAVAILABLE', 'IX Browser no longer reports the linked profile.', 'fail')
    const text = reply && isReplyPayload(reply) ? reply.text.trim() : composePost(draft!.body, draft!.hashtags)
    const media = reply ? [] : draft!.media.map((m) => this.deps.assetFile(m.id))
    if (media.some((path) => !path)) throw new TaskError('MEDIA_MISSING', 'An attached image is missing from the image folder.', 'fail')
    this.checkCancelled(context)

    const externalId = account.profile.externalId
    let address = this.deps.ixBrowser.debuggingAddressFor(externalId)
    let openedHere = false
    let lastStage = 'validate'
    try {
      if (!address) {
        context.stage('open-profile')
        try {
          // Asked even when IX lists the profile as opened: that list is not "open on this computer".
          const opening = this.deps.ixBrowser.openProfile(externalId, { evenIfListedOpen: true })
          const stopped = await this.untilAborted(opening, context.signal)
          if (stopped) {
            // Stop promptly; if IX Browser still opens the profile, close it again so no browser is left behind.
            opening.then(() => this.deps.ixBrowser.closeProfile(externalId)).catch(() => undefined)
            throw new TaskError('CANCELLED', 'Stopped before anything was posted.', 'retry')
          }
          openedHere = true
        } catch (error) {
          if (error instanceof TaskError) throw error
          const kind = error instanceof IxBrowserError ? error.kind : null
          if (kind === 'unreachable' || kind === 'timeout') {
            this.deps.notifier?.notify(
              { tone: 'danger', event: 'taskFailures', title: 'Connection to IX Browser failed', body: 'Check that IX Browser is running and its Local API is enabled. Posts will be retried.', to: '/settings?section=ixbrowser' },
              { key: 'ix-unreachable' }
            )
            throw new TaskError('IX_UNREACHABLE', 'Could not reach IX Browser. Check that it is running with the Local API enabled.', 'retry')
          }
          const hint = kind === 'not-configured' ? ' Set up the IX Browser connection in Settings.' : ''
          // IX Browser's own answer (e.g. the profile is already open in a window), so the user knows what to fix.
          const ixSays = error instanceof IxBrowserError && kind !== 'not-configured' ? ` IX Browser says: ${error.message.slice(0, 200)}${error.code !== null ? ` (code ${error.code})` : ''}.` : ''
          throw new TaskError('PROFILE_OPEN_FAILED', `IX Browser could not open the profile.${hint}${ixSays} If its window is open, close it in IX Browser and retry.`, hint ? 'fail' : 'retry')
        }
        this.deps.notifier?.clear('ix-unreachable')
        address = this.deps.ixBrowser.debuggingAddressFor(externalId)
        if (!address) throw new TaskError('NO_DEBUG_ADDRESS', 'IX Browser opened the profile but did not provide a way to automate it. Run the compatibility check on this profile.', 'fail')
      }
      this.checkCancelled(context)

      const params: Record<string, unknown> = {
        endpoint: /^(https?|wss?):\/\//.test(address) ? address : `http://${address}`,
        text,
        media,
        timeoutMs: 30_000,
        confirmTimeoutMs: 45_000
      }
      if (account.handle && account.identity === 'confirmed') params.expectedHandle = account.handle
      if (reply && isReplyPayload(reply)) params.inReplyTo = reply.parentPostId
      if (this.deps.testBaseUrl) params.baseUrl = this.deps.testBaseUrl

      try {
        const reply = await this.deps.engine.request<PublishReply>('x.publish', params, {
          timeoutMs: 330_000,
          onProgress: (stage) => {
            lastStage = stage
            context.stage(stage)
          }
        })
        return { url: reply.url, postId: reply.postId, handle: reply.handle, verifiedBy: reply.verifiedBy === 'profile-check' ? 'profile-check' : 'post-link' }
      } catch (error) {
        if (error instanceof TaskError) throw error
        // The engine's own reason (already plain language; never the post text) is kept for the log and the review.
        if (error instanceof EngineError) this.deps.log.warn(`Engine: ${error.code} at stage “${this.stageLabel(lastStage)}”: ${error.message.slice(0, 300)}`, { submitted: error.submitted })
        const classified = this.classify(error, lastStage)
        // Submitted but unconfirmed: look for the post on the account's profile before asking the user.
        if (classified.disposition === 'review' && account.handle && account.identity === 'confirmed') {
          const found = await this.findOnProfile(params.endpoint as string, account.handle, text, context, Boolean(reply))
          if (found) return found
        }
        throw classified
      }
    } catch (error) {
      if (error instanceof TaskError) throw error
      throw this.classify(error, lastStage)
    } finally {
      if (openedHere && this.deps.settings().closeProfileAfterPublish) {
        await this.deps.ixBrowser.closeProfile(externalId).catch((error: unknown) => this.deps.log.error('Could not close the profile after publishing', error))
      }
    }
  }

  /** Finds a just-submitted post on the account's profile; null when not found or the check failed. */
  private async findOnProfile(endpoint: string, handle: string, text: string, context: TaskContext, replies = false): Promise<PublishResult | null> {
    if (!text.trim()) return null
    context.stage('check-profile')
    try {
      const params: Record<string, unknown> = { endpoint, handle, text, timeoutMs: 20_000 }
      // Replies are listed on the profile's Replies tab, not its posts.
      if (replies) params.replies = true
      if (this.deps.testBaseUrl) params.baseUrl = this.deps.testBaseUrl
      const reply = await this.deps.engine.request<{ found: boolean; url?: string; postId?: string; handle?: string }>('x.findPost', params, 60_000)
      if (!reply.found || !reply.url) return null
      this.deps.log.info('An unconfirmed post was found on the account’s profile')
      return { url: reply.url, postId: reply.postId ?? null, handle: reply.handle ?? handle, verifiedBy: 'profile-check' }
    } catch {
      return null
    }
  }

  /** Resolves true if the signal aborts before `work` settles (work keeps running). Rethrows work's error otherwise. */
  private async untilAborted(work: Promise<unknown>, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return true
    let onAbort: () => void = () => undefined
    const aborted = new Promise<true>((resolve) => {
      onAbort = () => resolve(true)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([work.then(() => false as const), aborted])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  private checkCancelled(context: TaskContext): void {
    if (context.signal.aborted) throw new TaskError('CANCELLED', 'Stopped before anything was posted.', 'retry')
  }

  private get noun(): string {
    return this.kind === 'reply' ? 'comment' : 'post'
  }

  /** Turns an engine failure into retry / fail / review, erring on the side of review. */
  private classify(error: unknown, lastStage: string): TaskError {
    const mayHavePosted = SUBMITTED_STAGES.has(lastStage)
    if (!(error instanceof EngineError)) {
      return mayHavePosted
        ? new TaskError('OUTCOME_UNKNOWN', 'Publishing was interrupted after the post was submitted. Check the account on X before trying again.', 'review')
        : new TaskError('PUBLISH_FAILED', 'Publishing stopped before anything was posted.', 'retry')
    }
    // The Post button was never clicked: nothing was posted, safe to try again.
    if (error.code === 'POST_BUTTON_BLOCKED') return new TaskError(error.code, `Something on X's page covered the Post button, so it was never clicked. Nothing was posted.`, 'retry')
    if (error.submitted === true || mayHavePosted) {
      if (error.code === 'REJECTED') return new TaskError('REJECTED', `X did not accept the ${this.noun}, so it was not published.${/X said: /.test(error.message) ? ` ${error.message.replace(/^.*?\(X said: /, 'X said: ').replace(/\)\.?$/, '.')}` : ''}`, 'fail')
      // Clicked, but X's composer still held the whole text and X said nothing: X did not take it.
      if (error.code === 'NOT_SENT') return new TaskError('NOT_SENT', `X did not take the ${this.noun}: after Post was clicked its composer still held the text, and X showed no notice. Nothing was posted — you can retry it.`, 'fail')
      const detail = error.code === 'OUTCOME_UNKNOWN' && error.message && !/confirming it failed/.test(error.message) ? ` ${error.message}` : ''
      return new TaskError('OUTCOME_UNKNOWN', `The ${this.noun} was submitted, but X did not confirm it.${detail} Check the account on X before trying again.`, 'review')
    }
    switch (error.code) {
      case 'ENGINE_TIMEOUT':
        // The engine stopped answering mid-command; it could still act. Stop it and let the user check.
        this.deps.engine.killNow()
        return new TaskError('OUTCOME_UNKNOWN', 'The automation engine stopped responding while publishing. Check the account on X before trying again.', 'review')
      case 'CONNECT_FAILED':
      case 'CONNECT_TIMEOUT':
        return new TaskError(error.code, 'Could not connect to the profile’s browser.', 'retry')
      case 'COMPOSER_NOT_FOUND':
        return new TaskError(error.code, this.kind === 'reply' ? 'The X reply composer did not load.' : 'The X post composer did not load.', 'retry')
      case 'MEDIA_UPLOAD_FAILED':
        return new TaskError(error.code, 'X did not finish taking the images. Nothing was posted.', 'retry')
      case 'SESSION_EXPIRED':
        return new TaskError(error.code, 'This profile is signed out of X. Sign in to X in IX Browser, then retry.', 'fail')
      case 'ACCOUNT_MISMATCH':
        return new TaskError(error.code, error.message, 'fail')
      case 'TEXT_MISMATCH':
        return new TaskError(error.code, 'The X composer did not take the text exactly, so nothing was posted.', 'fail')
      case 'POST_BUTTON_DISABLED':
        return new TaskError(error.code, `X did not allow posting (the ${this.noun} may be too long for this account, or replies are limited). Nothing was posted.`, 'fail')
      case 'NO_CONTEXT':
        return new TaskError(error.code, 'The profile’s browser session was not available. Nothing was posted.', 'fail')
      case 'MEDIA_MISSING':
        return new TaskError(error.code, 'An attached image is missing from the image folder.', 'fail')
      case 'ENGINE_UNAVAILABLE':
      case 'ENGINE_FAILED':
        return new TaskError(error.code, 'The automation engine is not available. Restart it in Settings → Automation engine, then retry.', 'fail')
      case 'INVALID_PARAMS':
        return new TaskError(error.code, 'The post could not be prepared for publishing.', 'fail')
      default:
        // Crashes, start-up failures and timeouts before the submit step: nothing was posted.
        return new TaskError(error.code || 'PUBLISH_FAILED', 'Publishing stopped before anything was posted.', 'retry')
    }
  }
}
