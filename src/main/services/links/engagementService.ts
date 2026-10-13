import { randomUUID } from 'node:crypto'
import type { BulkResult } from '@shared/types/accounts'
import type { Id } from '@shared/types/domain'
import {
  AMPLIFYING_KINDS,
  DEFAULT_ENGAGEMENT_SETTINGS,
  ENGAGEMENT_LIMITS,
  type EngagementCheck,
  type EngagementCreateResult,
  type EngagementInput,
  type EngagementKind,
  type EngagementProblem,
  type EngagementQuery,
  type EngagementSettings,
  type EngagementStatus,
  type EngagementTaskView,
  type EngagementUpdate
} from '@shared/types/links'
import type { SettingsRepository } from '../database/repositories'
import type { AccountRepository } from '../database/sqlite/accountRepository'
import type { EngagementRepository } from '../database/sqlite/engagementRepository'
import type { PostLinkRepository } from '../database/sqlite/postLinkRepository'
import { EngineError, type EngineService } from '../engine/engineService'
import { NotFoundError, ValidationError } from '../errors'
import { IxBrowserError } from '../integrations/ixbrowser/client'
import type { IxBrowserService } from '../integrations/ixbrowser/ixBrowserService'
import type { ScopedLogger } from '../logging/logger'

interface Deps {
  repo: EngagementRepository
  links: PostLinkRepository
  accounts: AccountRepository
  settings: SettingsRepository
  ixBrowser: IxBrowserService
  engine: EngineService
  log: ScopedLogger
  onChange: () => void
  /** Development/test only: a loopback stand-in for x.com. */
  testBaseUrl?: string | null
  now?: () => Date
}

const SETTINGS_KEY = 'engagement.settings'
const KIND_LABEL: Record<EngagementKind, string> = {
  reply: 'reply',
  like: 'like',
  repost: 'repost',
  quote: 'quote',
  bookmark: 'bookmark',
  'follow-up': 'follow-up',
  other: 'task'
}
/** Kinds that need an account (the rest can be general reminders). */
const NEEDS_ACCOUNT: readonly EngagementKind[] = ['reply', 'like', 'repost', 'quote', 'bookmark']

/**
 * Engagement tasks: a checklist of things a person plans to do with a post
 * from one of their accounts. X Auto never likes, reposts, quotes,
 * replies or follows on its own — it can open the post in the account's
 * IX Browser profile, and the person acts and marks the task done.
 *
 * Guardrails (X's platform manipulation and automation rules):
 *  - a post from one of your accounts can't be liked/reposted/quoted from your
 *    other accounts (artificial amplification);
 *  - only one of your accounts may like/repost/quote a given post
 *    (coordinated engagement), and the same comment can't come from several
 *    of your accounts on one post;
 *  - a configurable number of tasks per account per day;
 *  - no duplicate open task for the same post, account and kind.
 */
export class EngagementService {
  constructor(private readonly deps: Deps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  getSettings(): EngagementSettings {
    return { ...DEFAULT_ENGAGEMENT_SETTINGS, ...(this.deps.settings.get<Partial<EngagementSettings>>(SETTINGS_KEY) ?? {}) }
  }

  updateSettings(patch: Partial<EngagementSettings>): EngagementSettings {
    const next = { ...this.getSettings(), ...patch }
    const [min, max] = ENGAGEMENT_LIMITS.dailyLimitPerAccount
    if (!Number.isInteger(next.dailyLimitPerAccount) || next.dailyLimitPerAccount < min || next.dailyLimitPerAccount > max) {
      throw new ValidationError(`The daily guideline must be a whole number between ${min} and ${max}.`)
    }
    this.deps.settings.set(SETTINGS_KEY, next)
    this.deps.onChange()
    return next
  }

  list(query: EngagementQuery): EngagementTaskView[] {
    return this.deps.repo.list(query)
  }

  counts(): { open: number; overdue: number } {
    return this.deps.repo.counts()
  }

  /** The guardrails for one planned task on one post. */
  check(input: Omit<EngagementInput, 'linkIds'> & { linkId: Id }, excludeId: Id | null = null): EngagementCheck {
    const problems: EngagementProblem[] = []
    const add = (code: EngagementProblem['code'], message: string, blocking = true) => problems.push({ code, message, blocking })
    const link = this.deps.links.get(input.linkId)
    if (!link) {
      add('link-missing', 'That link no longer exists.')
      return { linkId: input.linkId, ok: false, problems }
    }
    const account = input.accountId ? this.deps.accounts.get(input.accountId) : null
    if (!input.accountId && NEEDS_ACCOUNT.includes(input.kind)) add('no-account', `Choose the account that will ${KIND_LABEL[input.kind]} this post.`)
    else if (input.accountId && !account) add('account-missing', 'That account no longer exists.')
    if (account && !account.enabled) add('account-disabled', `${account.label} is disabled for tasks.`, false)

    if (this.deps.repo.openDuplicate(input.linkId, input.accountId, input.kind, excludeId)) {
      add('duplicate', `There is already an open ${KIND_LABEL[input.kind]} task for this post${account ? ` and ${account.label}` : ''}.`)
    }

    if (account && AMPLIFYING_KINDS.includes(input.kind)) {
      const owner = link.accountId ? this.deps.accounts.get(link.accountId) : link.handle ? this.deps.accounts.byHandle(link.handle) : null
      if (owner && owner.id !== account.id) {
        add(
          'own-amplification',
          `This post is from ${owner.label}, one of your accounts. Liking, reposting or quoting it from your other accounts is artificial amplification, which X’s rules don’t allow.`
        )
      }
      const others = this.deps.repo.otherAccountsWithKinds(input.linkId, AMPLIFYING_KINDS, account.id, excludeId)
      if (others.length) {
        const names = others.map((id) => this.deps.accounts.get(id)?.label ?? 'Another account').join(', ')
        add('coordinated', `${names} already has a like, repost or quote planned for this post. Using several of your accounts to amplify the same post is coordinated activity X’s rules don’t allow.`)
      }
    }

    if (account && input.kind === 'reply' && input.replyText.trim()) {
      const withSame = this.deps.repo.accountsWithReply(input.linkId, input.replyText, excludeId)
      if (withSame.includes(account.id)) add('duplicate', `${account.label} already has this same comment on this post.`)
      const others = withSame.filter((id) => id !== account.id)
      if (others.length) {
        const names = others.map((id) => this.deps.accounts.get(id)?.label ?? 'Another account').join(', ')
        add('coordinated', `${names} already has this same comment planned for this post. The same comment from several of your accounts is coordinated activity X’s rules don’t allow.`)
      }
    }

    const limit = this.getSettings().dailyLimitPerAccount
    if (account && limit > 0) {
      const day = input.dueAt ? new Date(input.dueAt) : this.now()
      const start = new Date(day.getFullYear(), day.getMonth(), day.getDate())
      const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
      const planned = this.deps.repo.countForDay(account.id, start.toISOString(), end.toISOString(), excludeId)
      if (planned >= limit) {
        add('daily-limit', `${account.label} already has ${planned} engagement tasks for that day (your guideline is ${limit}). Spread them out, or change the guideline in Settings → Publishing.`)
      }
    }
    return { linkId: input.linkId, ok: !problems.some((p) => p.blocking), problems }
  }

  checkMany(input: EngagementInput): EngagementCheck[] {
    return [...new Set(input.linkIds)].map((linkId) => this.check({ ...input, linkId }))
  }

  create(input: EngagementInput): EngagementCreateResult {
    this.validate(input)
    const result: EngagementCreateResult = { created: [], skipped: [] }
    const now = this.now().toISOString()
    this.deps.repo.transaction(() => {
      for (const linkId of new Set(input.linkIds)) {
        // Checked one by one so the daily guideline counts tasks created in this batch.
        const check = this.check({ ...input, linkId })
        const blocking = check.problems.find((p) => p.blocking)
        if (blocking) {
          result.skipped.push({ linkId, reason: blocking.message })
          continue
        }
        const id = randomUUID()
        this.deps.repo.insert({
          id,
          linkId,
          accountId: input.accountId,
          kind: input.kind,
          status: 'open',
          dueAt: input.dueAt,
          note: input.note.trim(),
          replyText: input.replyText.trim(),
          createdAt: now,
          updatedAt: now,
          completedAt: null
        })
        result.created.push(this.deps.repo.view(id)!)
      }
    })
    if (result.created.length) {
      this.deps.log.info(`Planned ${result.created.length} engagement task(s)`, { kind: input.kind, skipped: result.skipped.length })
      this.deps.onChange()
    }
    return result
  }

  update(id: Id, update: EngagementUpdate): EngagementTaskView {
    const task = this.deps.repo.get(id)
    if (!task) throw new NotFoundError('That task no longer exists.')
    this.validate({ ...update, linkIds: [task.linkId] })
    const check = this.check({ ...update, linkId: task.linkId }, id)
    const blocking = check.problems.find((p) => p.blocking)
    if (blocking) throw new ValidationError(blocking.message)
    this.deps.repo.update(id, { ...update, note: update.note.trim(), replyText: update.replyText.trim() }, this.now().toISOString())
    this.deps.onChange()
    return this.deps.repo.view(id)!
  }

  setStatus(ids: Id[], status: EngagementStatus): BulkResult {
    const result: BulkResult = { changed: 0, skipped: [] }
    const now = this.now().toISOString()
    this.deps.repo.transaction(() => {
      for (const id of new Set(ids)) {
        const task = this.deps.repo.get(id)
        if (!task) {
          result.skipped.push({ id, reason: 'Not found' })
          continue
        }
        if (status === 'open' && this.deps.repo.openDuplicate(task.linkId, task.accountId, task.kind, id)) {
          result.skipped.push({ id, reason: 'An identical task is already open' })
          continue
        }
        if (this.deps.repo.setStatus(id, status, now)) result.changed++
      }
    })
    if (result.changed) this.deps.onChange()
    return result
  }

  remove(ids: Id[]): BulkResult {
    const result: BulkResult = { changed: 0, skipped: [] }
    this.deps.repo.transaction(() => {
      for (const id of new Set(ids)) {
        if (this.deps.repo.remove(id)) result.changed++
        else result.skipped.push({ id, reason: 'Not found' })
      }
    })
    if (result.changed) this.deps.onChange()
    return result
  }

  /**
   * Opens the task's post in its account's IX Browser profile (opening the
   * profile through the Local API if needed) and leaves it for the person.
   * Nothing on the page is clicked or typed.
   */
  async openInProfile(taskId: Id): Promise<{ signedOut: boolean }> {
    const task = this.deps.repo.view(taskId)
    if (!task) throw new NotFoundError('That task no longer exists.')
    const account = task.accountId ? this.deps.accounts.get(task.accountId) : null
    if (!account) throw new ValidationError('This task has no account. Choose one, or open the post in your browser.')
    if (!account.profile) throw new ValidationError(`${account.label} is not linked to an IX Browser profile.`)
    if (account.profile.availability === 'unavailable') throw new ValidationError('IX Browser no longer reports the linked profile.')
    const externalId = account.profile.externalId
    let address = this.deps.ixBrowser.debuggingAddressFor(externalId)
    if (!address) {
      try {
        // IX's opened-list is not "open on this computer", so IX is asked and answers for itself.
        await this.deps.ixBrowser.openProfile(externalId, { evenIfListedOpen: true })
      } catch (error) {
        throw new ValidationError(
          error instanceof IxBrowserError && error.kind === 'not-configured'
            ? 'Set up the IX Browser connection in Settings first.'
            : `IX Browser could not open the profile.${error instanceof IxBrowserError ? ` IX Browser says: ${error.message.slice(0, 200)}` : ''} If its window is open, close it in IX Browser and try again.`
        )
      }
      address = this.deps.ixBrowser.debuggingAddressFor(externalId)
      if (!address) throw new ValidationError('IX Browser opened the profile but did not provide a way to open the post in it.')
    }
    const params: Record<string, unknown> = { endpoint: /^(https?|wss?):\/\//.test(address) ? address : `http://${address}`, url: task.linkUrl, timeoutMs: 20_000 }
    if (this.deps.testBaseUrl) params.baseUrl = this.deps.testBaseUrl
    try {
      const reply = await this.deps.engine.request<{ opened: boolean; signedOut: boolean }>('x.openPost', params, 45_000)
      this.deps.log.info(`Opened a post in profile ${externalId} for an engagement task`)
      return { signedOut: reply.signedOut === true }
    } catch (error) {
      const code = error instanceof EngineError ? error.code : ''
      throw new ValidationError(
        code === 'CONNECT_FAILED' || code === 'CONNECT_TIMEOUT' ? 'Could not connect to the profile’s browser.' : code.startsWith('ENGINE_') ? 'The automation engine is not available right now.' : 'The post could not be opened in the profile.'
      )
    }
  }

  private validate(input: Pick<EngagementInput, 'linkIds' | 'note' | 'replyText' | 'dueAt'>): void {
    if (!input.linkIds.length) throw new ValidationError('Choose at least one link.')
    if (input.linkIds.length > 500) throw new ValidationError('Plan tasks for at most 500 links at a time.')
    if (input.note.length > 1000) throw new ValidationError('Notes can be up to 1,000 characters.')
    if (input.replyText.length > 4000) throw new ValidationError('Reply text can be up to 4,000 characters.')
    if (input.dueAt && Number.isNaN(Date.parse(input.dueAt))) throw new ValidationError('Choose a valid due date.')
  }
}
