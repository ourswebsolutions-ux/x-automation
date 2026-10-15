import { randomUUID } from 'node:crypto'
import { composePost, LENGTH_PROFILES } from '@shared/config/postLimits'
import { attachmentProblem } from '@shared/config/mediaLimits'
import { measurePost } from '@shared/lib/postLength'
import type {
  AutomationConfig,
  AutomationMode,
  AutomationRun,
  PromptPreset,
  RunCounts,
  RunDetails,
  RunItem,
  RunItemStatus,
  RunPlan,
  RunStatus
} from '@shared/types/automation'
import type { Id, ScheduleStatus, TaskStatus } from '@shared/types/domain'
import type { GenerationBrief } from '@shared/types/generator'
import type { SqliteDatabase } from '../database/driver'
import type { AccountRepository } from '../database/sqlite/accountRepository'
import type { AssetRepository } from '../database/sqlite/assetRepository'
import type { ProfileRepository } from '../database/sqlite/profileRepository'
import type { DraftService } from '../drafts/draftService'
import { CommentDraftService } from '../drafts/commentDraftService'
import { ConflictError, NotFoundError, ValidationError } from '../errors'
import type { GeneratorService } from '../generator/generatorService'
import type { ImageService } from '../images/imageService'
import type { AccountService } from '../accounts/accountService'
import type { EngagementService } from '../links/engagementService'
import type { ScopedLogger } from '../logging/logger'
import type { Notifier } from '../notifications/notifier'
import type { ProviderService } from '../providers/providerService'
import type { PreferencesStore } from '../preferences/preferencesStore'
import { parsePostUrl, type ParsedPostUrl } from '../publishing/postUrl'
import type { PublishingService } from '../publishing/publishingService'
import type { QueueService } from '../queue/queueService'
import { parseConfig } from './configSchema'

interface Deps {
  db: SqliteDatabase
  generator: Pick<GeneratorService, 'generate'>
  images: Pick<ImageService, 'generate' | 'suggestPrompt'>
  drafts: Pick<DraftService, 'save' | 'get' | 'duplicate'>
  assets: Pick<AssetRepository, 'get'>
  accounts: AccountRepository
  accountService: Pick<AccountService, 'createFromProfiles'>
  profiles: ProfileRepository
  providers: Pick<ProviderService, 'list'>
  preferences: Pick<PreferencesStore, 'get'>
  publishing: PublishingService
  engagement: Pick<EngagementService, 'create' | 'setStatus' | 'check'>
  /** Saved comments (bulk comments); made from db when not given. */
  comments?: Pick<CommentDraftService, 'byIds' | 'markUsed'>
  queue: QueueService
  notifier: Notifier
  log: ScopedLogger
  onChange: () => void
  now?: () => Date
}

interface ItemRow {
  id: string
  run_id: string
  position: number
  kind: 'post' | 'engagement'
  status: RunItemStatus
  profile_id: string | null
  account_id: string | null
  draft_id: string | null
  schedule_id: string | null
  engagement_task_id: string | null
  source_draft_id: string | null
  run_at: string | null
  image: RunItem['image']
  error: string | null
}

const ACTIVE: RunStatus[] = ['generating', 'awaiting-approval', 'paused']
const MAX_BATCH = 5
const SAFE_INSTRUCTIONS =
  'Write original posts in your own words. Do not invent facts, statistics, quotes, prices, dates or news, do not claim to be a real person, and do not copy other posts.'

/** Runs started before content sources existed used generated (or fixed) text. */
const withContentDefaults = (config: AutomationConfig): AutomationConfig => ({ ...config, content: { ...config.content, source: config.content.source ?? 'generate', draftIds: config.content.draftIds ?? [] } })

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

/** The first allowed posting moment at or after `at`: on a posting day, inside the posting hours. */
function nextAllowed(config: AutomationConfig, at: Date): Date {
  const wh = config.schedule.workingHours
  const days = config.schedule.days?.length ? config.schedule.days : [0, 1, 2, 3, 4, 5, 6]
  if (!wh.enabled && days.length === 7) return at
  const from = wh.enabled ? minutesOf(wh.start) : 0
  const to = wh.enabled ? minutesOf(wh.end) : 24 * 60
  let t = new Date(at)
  for (let guard = 0; guard < 800; guard++) {
    const minute = t.getHours() * 60 + t.getMinutes()
    const inHours = !wh.enabled || (from < to ? minute >= from && minute < to : minute >= from || minute < to)
    if (inHours && days.includes(t.getDay())) return t
    // Next window start today if it is still ahead (and today is a posting day), else tomorrow's.
    const next = new Date(t)
    next.setHours(Math.floor(from / 60), from % 60, 0, 0)
    if (next <= t || !days.includes(t.getDay())) {
      next.setDate(next.getDate() + 1)
      next.setHours(Math.floor(from / 60), from % 60, 0, 0)
    }
    t = next
  }
  return t
}

/** A seeded random order (mulberry32 + Fisher–Yates): the same seed always gives the same order. */
export function shuffleWithSeed<T>(items: T[], seed: number): T[] {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

/**
 * The posting time for slot `index` of a profile. Slots follow each other: each is the first
 * allowed moment (posting day, posting hours) at least one interval after the previous slot,
 * so two posts of one account never land on the same time.
 */
export function slotTime(config: AutomationConfig, start: Date, index: number): Date {
  const interval = config.schedule.intervalMinutes * 60_000
  let at = nextAllowed(config, start)
  for (let i = 0; i < index; i++) at = nextAllowed(config, new Date(at.getTime() + interval))
  return at
}

/**
 * Automation runs: one press of "Start automation". A run generates the posts
 * (text through the configured AI provider, an image per post when enabled),
 * saves them as drafts with their images attached, and then — in Full Auto —
 * schedules each one for its target profile, where the task queue publishes
 * it through the verified browser workflow. In Manual Approval the posts wait
 * for the user. Nothing is confirmed per post in Full Auto; nothing is
 * published in Manual Approval until approved.
 */
export class RunService {
  private readonly processing = new Set<string>()
  private readonly failuresInRow = new Map<string, number>()

  private readonly comments: Pick<CommentDraftService, 'byIds' | 'markUsed'>
  private lastStart: { key: string; runId: string } | null = null

  constructor(private readonly deps: Deps) {
    this.comments = deps.comments ?? new CommentDraftService(deps.db, deps.log)
    deps.queue.onSettled((task, settlement) => {
      // A campaign repost or comment: its Post Links task is done once X confirmed it; the run finishes when all have an outcome.
      const engagementTaskId = typeof task.payload.engagementTaskId === 'string' ? task.payload.engagementTaskId : null
      if ((task.kind === 'repost' || task.kind === 'reply') && engagementTaskId) {
        if (settlement.status === 'succeeded') {
          try {
            deps.engagement.setStatus([engagementTaskId], 'done')
          } catch (error) {
            deps.log.warn('Could not mark the engagement task done', { reason: error instanceof Error ? error.message : 'unknown' })
          }
        }
        const owner = deps.db.get<{ run_id: string }>("SELECT run_id FROM run_items WHERE engagement_task_id = :id AND kind = 'engagement'", { id: engagementTaskId })
        if (owner) this.checkFinished(owner.run_id)
        return
      }
      // A comment settles after its post: the run finishes once both have an outcome.
      if (task.kind === 'reply' && task.draftId) {
        const owner = deps.db.get<{ run_id: string }>("SELECT run_id FROM run_items WHERE draft_id = :id AND kind = 'post'", { id: task.draftId })
        if (owner) this.checkFinished(owner.run_id)
        return
      }
      if (task.kind !== 'publish' || !task.scheduleId) return
      const row = deps.db.get<{ run_id: string }>('SELECT run_id FROM run_items WHERE schedule_id = :id', { id: task.scheduleId })
      if (!row) return
      if (settlement.status === 'failed' || settlement.status === 'needs-review') this.countFailure(row.run_id)
      else if (settlement.status === 'succeeded') this.failuresInRow.set(row.run_id, 0)
      this.checkFinished(row.run_id)
    })
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  // ── presets ──────────────────────────────────────────────────────────────

  listPresets(): PromptPreset[] {
    return this.deps.db.all<{ id: string; name: string; config: string; created_at: string; updated_at: string }>('SELECT * FROM prompt_presets ORDER BY name COLLATE NOCASE').flatMap((r) => {
      try {
        return [{ id: r.id, name: r.name, config: parseConfig(JSON.parse(r.config)), createdAt: r.created_at, updatedAt: r.updated_at }]
      } catch {
        return [] // a preset from a newer/older format that no longer validates is not offered
      }
    })
  }

  savePreset(input: { id?: Id; name: string; config: AutomationConfig }): PromptPreset {
    const name = input.name.trim()
    if (!name || name.length > 80) throw new ValidationError('Give the preset a name (up to 80 characters).')
    const config = parseConfig(input.config)
    const clash = this.deps.db.get<{ id: string }>('SELECT id FROM prompt_presets WHERE lower(name) = lower(:name)', { name })
    if (clash && clash.id !== input.id) throw new ValidationError('A preset with that name already exists.')
    const now = this.now().toISOString()
    const id = input.id ?? randomUUID()
    this.deps.db.run(
      `INSERT INTO prompt_presets (id, name, config, created_at, updated_at) VALUES (:id, :name, :config, :now, :now)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, config = excluded.config, updated_at = excluded.updated_at`,
      { id, name, config: JSON.stringify(config), now }
    )
    this.deps.onChange()
    return this.listPresets().find((p) => p.id === id)!
  }

  removePreset(id: Id): void {
    if (!this.deps.db.run('DELETE FROM prompt_presets WHERE id = :id', { id }).changes) throw new NotFoundError('That preset no longer exists.')
    this.deps.onChange()
  }

  // ── plan ─────────────────────────────────────────────────────────────────

  /** What Start would do, with every blocking problem and warning. Nothing is changed. */
  plan(input: AutomationConfig): RunPlan {
    const config = parseConfig(input)
    const problems: RunPlan['problems'] = []
    const block = (message: string) => problems.push({ message, blocking: true })
    const warn = (message: string) => problems.push({ message, blocking: false })
    const { content, targets, actions, schedule } = config
    const publishing = actions.publish && targets.distribution !== 'drafts'

    // Your own drafts (source drafts / mixed): only unscheduled, unpublished ones can be used.
    // Posts are only needed when the campaign posts (a Repost-only campaign has none).
    const useDrafts = content.source !== 'generate' && (actions.publish || actions.saveDrafts)
    const usableDrafts = useDrafts ? this.usableDrafts(content.draftIds) : []
    if (useDrafts) {
      if (content.draftIds.length === 0) block('Choose the drafts to post.')
      const unusable = content.draftIds.length - usableDrafts.length
      if (unusable > 0) block(`${unusable} selected ${unusable === 1 ? 'draft is' : 'drafts are'} already scheduled, published or deleted. Remove ${unusable === 1 ? 'it' : 'them'} from the selection.`)
    }
    const needsGeneration = content.source !== 'drafts'
    if (needsGeneration && content.generateText) {
      if (content.prompt.trim().length + content.topic.trim().length < 3) block('Describe the posts you want in the prompt.')
      const provider = this.textProvider(config)
      if (!provider) block('Choose an AI text provider with a key (Settings → AI providers & keys).')
    } else if (needsGeneration && !content.fixedText.trim() && !content.existingAssetId) block('Turn text generation on, or write the text to post.')
    if (content.generateImages && !this.imageProvider(config)) block('Choose an image provider with a key, or turn image generation off.')
    if (!content.generateImages && content.existingAssetId) {
      const asset = this.deps.assets.get(content.existingAssetId)
      if (!asset) block('The selected library image no longer exists.')
      else {
        const problem = attachmentProblem(asset)
        if (problem) block(`The selected image can’t be attached: ${problem}`)
      }
    }
    if (!actions.publish && !actions.saveDrafts && !actions.repost && !actions.comment && !actions.like) block('Turn on at least one action.')

    // Profiles: never treat an empty or failed sync as "all".
    const synced = this.deps.profiles.list()
    const chosen = targets.scope === 'all' ? synced : synced.filter((p) => targets.profileIds.includes(p.id))
    if (targets.scope === 'all' && synced.length === 0) block('No profiles are synced from IX Browser yet. Sync profiles first.')
    if (targets.scope === 'selected' && chosen.length === 0 && targets.distribution !== 'drafts') block('Select at least one profile.')
    const listed: RunPlan['targets'] = chosen.map((profile) => {
      const account = this.deps.accounts.byProfile(profile.id)
      let reason: string | null = null
      if (profile.availability !== 'available') reason = 'Not reported by IX Browser'
      else if (!account) reason = targets.requireConfirmedIdentity || !targets.createMissingAccounts ? 'No account linked' : null
      else if (!account.enabled) reason = 'Account disabled for tasks'
      else if (targets.requireConfirmedIdentity && (account.identity !== 'confirmed' || !account.handle)) reason = 'Username not confirmed'
      return { profileId: profile.id, profileName: profile.name, accountId: account?.id ?? null, accountLabel: account?.label ?? null, eligible: reason === null, reason }
    })
    // The campaign's random account order (same seed → same order, so Start = the preview).
    const plannedTargets = targets.shuffleSeed === undefined ? listed : shuffleWithSeed(listed, targets.shuffleSeed)
    const unavailable = plannedTargets.filter((t) => t.reason === 'Not reported by IX Browser').length
    const eligible = plannedTargets.filter((t) => t.eligible)
    if (unavailable && config.failure.onProfileUnavailable === 'stop') block(`${unavailable} selected ${unavailable === 1 ? 'profile is' : 'profiles are'} unavailable.`)
    else if (unavailable) warn(`${unavailable} ${unavailable === 1 ? 'profile is' : 'profiles are'} unavailable and will be left out.`)
    const notLinked = plannedTargets.filter((t) => t.reason === 'No account linked').length
    const unconfirmed = plannedTargets.filter((t) => t.reason === 'Username not confirmed').length
    if (notLinked) warn(`${notLinked} ${notLinked === 1 ? 'profile has' : 'profiles have'} no account record and will be left out.`)
    if (unconfirmed) warn(`${unconfirmed} ${unconfirmed === 1 ? 'account has' : 'accounts have'} no confirmed X username, so the signed-in account can’t be checked — left out.`)
    const unchecked = eligible.filter((t) => {
      const account = t.accountId ? this.deps.accounts.get(t.accountId) : null
      return !account || account.identity !== 'confirmed' || !account.handle
    }).length
    if (!targets.requireConfirmedIdentity && publishing && unchecked) {
      warn(`${unchecked} of ${eligible.length} ${eligible.length === 1 ? 'profile' : 'profiles'} ${unchecked === 1 ? 'has' : 'have'} no confirmed X username, so posts go out without checking which X account is signed in there.`)
    }
    if ((publishing || actions.repost || actions.comment || actions.like) && eligible.length === 0 && chosen.length > 0) block('None of the chosen profiles can be used.')

    // Posts.
    let posts = 0
    let generations = 0
    if (actions.publish || actions.saveDrafts) {
      if (targets.distribution === 'drafts' || !publishing) {
        generations = schedule.postsPerProfile
        posts = generations
      } else if (targets.distribution === 'same') {
        if (eligible.length > 1 && !targets.allowDuplicates) block('Posting the same text on several profiles is off. Choose different posts per profile, or allow repeated content.')
        if (eligible.length > 1 && targets.allowDuplicates) warn('The same text will go out on several profiles. X may limit repeated content.')
        generations = schedule.postsPerProfile
        posts = eligible.length * schedule.postsPerProfile
      } else {
        posts = eligible.length * schedule.postsPerProfile
        generations = posts
      }
      if (posts > schedule.maxPostsPerRun) {
        warn(`Limited to ${schedule.maxPostsPerRun} posts per run (${posts} were planned).`)
        posts = schedule.maxPostsPerRun
        generations = Math.min(generations, posts)
      }
    }
    // Drafts fill the first slots (one per unique text); generation covers the rest (mixed) or nothing (drafts).
    let fromDrafts = 0
    if (useDrafts && (actions.publish || actions.saveDrafts)) {
      if (!publishing) block('Your drafts are already saved. Turn on publishing to post them, or choose generated posts.')
      else {
        const textsNeeded = generations
        fromDrafts = Math.min(usableDrafts.length, textsNeeded)
        if (content.source === 'drafts') {
          if (usableDrafts.length < textsNeeded && usableDrafts.length > 0) warn(`Only ${usableDrafts.length} ${usableDrafts.length === 1 ? 'draft is' : 'drafts are'} selected, so ${usableDrafts.length === 1 ? 'it covers' : 'they cover'} only part of the planned posts.`)
          if (usableDrafts.length > textsNeeded) warn(`${usableDrafts.length - textsNeeded} of the selected drafts don’t fit this run (posts per profile or the run limit) and stay as drafts.`)
          const perText = targets.distribution === 'same' ? Math.max(eligible.length, 1) : 1
          posts = Math.min(posts, fromDrafts * perText)
          generations = 0
        } else generations = Math.max(textsNeeded - fromDrafts, 0)
      }
    }
    if (content.source === 'generate' && content.generateText === false && generations > 1 && targets.distribution === 'unique' && !targets.allowDuplicates && publishing) {
      block('Without text generation every post has the same text. Allow repeated content, or turn text generation on.')
    }

    // Times: a campaign runs as soon as it starts. A run date or time (older saved setups) is refused
    // rather than silently scheduled for later.
    if (schedule.when === 'schedule') block('Campaigns start right away — a run date or time can’t be set. Press Run campaign to start it now.')
    const start = this.now()
    if (schedule.endAt && start && new Date(schedule.endAt) <= start) block('The end time must be after the start time.')
    if (schedule.days && schedule.days.length === 0) block('Choose at least one posting day.')
    let firstRunAt: string | null = null
    let lastRunAt: string | null = null
    if (publishing && start && posts > 0) {
      const perProfile = targets.distribution === 'same' || targets.distribution === 'unique' ? Math.ceil(posts / Math.max(eligible.length, 1)) : posts
      const first = slotTime(config, start, 0)
      const last = slotTime(config, start, Math.max(perProfile - 1, 0))
      firstRunAt = first.toISOString()
      lastRunAt = last.toISOString()
      if (schedule.endAt && last > new Date(schedule.endAt)) warn('Some posts fall after the end time and will be left out.')
    }

    // Engagement (planned as manual tasks).
    const links = actions.engagementLinks.map((l) => l.trim()).filter(Boolean)
    const kinds = [actions.repost && 'repost', actions.comment && 'comment', actions.like && 'like'].filter(Boolean) as string[]
    const badLinks = links.filter((l) => !parsePostUrl(l))
    // Saved comments (bulk comments): each goes on its own target post or on a selected post.
    const savedComments = actions.comment && actions.commentIds?.length ? this.comments.byIds(actions.commentIds) : null
    const ownTargets = savedComments?.filter((c) => c.targetUrl).length ?? 0
    if (kinds.length && links.length === 0 && !(kinds.length === 1 && ownTargets > 0)) block(savedComments ? 'Select the posts to comment on (or give your comments a target post).' : 'Add the post links for reposting, commenting or liking.')
    if (badLinks.length) block(`${badLinks.length} engagement ${badLinks.length === 1 ? 'link is' : 'links are'} not a link to a post on X.`)
    if (savedComments) {
      const missing = new Set(actions.commentIds).size - savedComments.length
      if (savedComments.length === 0) block('The selected comments no longer exist. Choose your comments again.')
      else if (missing > 0) warn(`${missing} selected ${missing === 1 ? 'comment no longer exists' : 'comments no longer exist'} and ${missing === 1 ? 'is' : 'are'} left out.`)
    } else if (actions.comment && !actions.commentText.trim()) block(actions.commentIds ? 'Choose the comments to post.' : 'Write the comment.')
    // Post campaigns from your saved posts: each post with its account and time — what Start will create.
    const postPreview: RunPlan['postPreview'] = []
    if (publishing && content.source === 'drafts' && fromDrafts > 0 && start && !problems.some((p) => p.blocking)) {
      const texts = new Map(this.deps.db.all<{ id: string; body: string }>('SELECT id, body FROM drafts WHERE id IN (SELECT value FROM json_each(:ids))', { ids: JSON.stringify(content.draftIds) }).map((d) => [d.id, d.body]))
      const draftIds = usableDrafts.slice(0, fromDrafts).map((d) => d.id)
      for (const slot of this.postSlots(config, eligible, start, schedule.endAt ? new Date(schedule.endAt) : null, draftIds, posts)) {
        postPreview.push({ draftId: slot.sourceDraftId ?? '', text: texts.get(slot.sourceDraftId ?? '') ?? '', accountId: slot.accountId, accountLabel: eligible.find((t) => t.accountId === slot.accountId)?.accountLabel ?? null, runAt: slot.runAt })
      }
    }

    // Each selected post gets one of your accounts (several of your accounts on one post is coordinated
    // engagement); the same comment goes on one post only (repetitive automated replies). The preview
    // shows the assignment Start will make, with every skipped post and its reason.
    const engagementPreview = kinds.length && !badLinks.length ? this.engagementAssignments(config, eligible.map((t) => t.accountId).filter((a): a is string => Boolean(a))).map((a) => ({ url: a.url, kind: a.kind, accountId: a.accountId, accountLabel: a.accountId ? (this.deps.accounts.get(a.accountId)?.label ?? null) : null, runAt: a.accountId ? a.dueAt : null, skipped: a.skipped, text: a.text, commentId: a.commentId })) : []
    const engagementTasks = engagementPreview.filter((p) => !p.skipped).length
    if (kinds.length && links.length && !badLinks.length && engagementTasks === 0) block('None of the selected posts can be assigned to one of your accounts — see the reasons in the preview.')
    if (actions.comment && !savedComments && links.length > 1) warn('The same comment goes on one post only (repeating it on several posts is repetitive replying): the other selected posts are skipped. Write a separate comment for each post.')
    if (engagementTasks && actions.like) warn('Likes are planned as tasks you complete in the profile — X Auto doesn’t like posts by itself.')
    if (engagementTasks && (actions.repost || actions.comment)) warn('Each post is reposted or commented on from one of your accounts only — several of your accounts on one post is coordinated engagement.')
    if (savedComments) {
      const noTarget = engagementPreview.filter((p) => p.kind === 'reply' && p.commentId && p.skipped).length
      const noComment = engagementPreview.filter((p) => p.kind === 'reply' && !p.commentId && p.skipped).length
      if (noTarget) warn(`${noTarget} ${noTarget === 1 ? 'comment has' : 'comments have'} no post to go on and ${noTarget === 1 ? 'is' : 'are'} skipped — select more posts, or fewer comments. One comment per post.`)
      if (noComment) warn(`${noComment} selected ${noComment === 1 ? 'post has' : 'posts have'} no comment left and ${noComment === 1 ? 'is' : 'are'} skipped — select more comments.`)
    }

    const summary: string[] = []
    if (publishing) summary.push(config.mode === 'full-auto' ? 'Publish automatically' : 'Publish after your approval')
    else if (actions.publish || actions.saveDrafts) summary.push('Save as drafts only')
    if (fromDrafts) summary.push(`Post ${fromDrafts} of your drafts${content.source === 'mixed' && generations ? ', then generated posts' : ''}`)
    if (content.source !== 'drafts' && (content.source === 'generate' || generations > 0)) summary.push(content.generateText ? 'Generate text with AI' : 'Use your own text')
    if (content.generateImages) summary.push(useDrafts ? 'Generate and attach an image per post (drafts without one)' : 'Generate and attach an image per post')
    else if (content.existingAssetId) summary.push('Attach the selected library image')
    if (actions.repost && engagementTasks) summary.push('Repost now, confirmed on X')
    if (actions.comment && engagementTasks) summary.push('Post the comment now, confirmed on X')
    if (actions.like && engagementTasks) summary.push('Plan like tasks (done by you)')

    // Comments saved with the chosen posts go out as replies to each post (one per post, same account).
    const withComment = usableDrafts.slice(0, fromDrafts).filter((d) => d.hasComment).length
    const perText = targets.distribution === 'same' ? Math.max(eligible.length, 1) : 1
    const comments = publishing && fromDrafts ? Math.min(withComment * perText, posts) : 0
    if (comments) summary.push(`Post ${comments === 1 ? 'the comment' : `${comments} comments`} as a reply from the same account after each post`)

    return {
      ok: !problems.some((p) => p.blocking),
      problems,
      profiles: {
        selected: chosen.length,
        available: chosen.length - unavailable,
        unavailable,
        eligible: eligible.length,
        withoutAccount: notLinked,
        unconfirmed
      },
      targets: plannedTargets,
      posts,
      generations,
      fromDrafts,
      // Generated images, or (campaigns from saved posts) the posts that already carry an image.
      images: content.generateImages ? generations + usableDrafts.slice(0, fromDrafts).filter((d) => !d.hasMedia).length : usableDrafts.slice(0, fromDrafts).filter((d) => d.hasMedia).length,
      comments,
      engagementTasks,
      postPreview,
      engagementPreview,
      firstRunAt,
      lastRunAt,
      actions: summary
    }
  }

  // ── runs ─────────────────────────────────────────────────────────────────

  list(limit = 30): AutomationRun[] {
    return this.deps.db.all<Record<string, string>>('SELECT * FROM automation_runs ORDER BY created_at DESC LIMIT :limit', { limit }).map((r) => this.toRun(r))
  }

  details(runId: Id): RunDetails {
    const row = this.deps.db.get<Record<string, string>>('SELECT * FROM automation_runs WHERE id = :id', { id: runId })
    if (!row) throw new NotFoundError('That automation run no longer exists.')
    return { run: this.toRun(row), items: this.items(runId) }
  }

  active(): AutomationRun | null {
    const row = this.deps.db.get<Record<string, string>>(
      `SELECT * FROM automation_runs WHERE status IN ('generating', 'awaiting-approval', 'paused', 'publishing') ORDER BY created_at DESC LIMIT 1`
    )
    return row ? this.toRun(row) : null
  }

  /** Starts a run (the single confirmation happens in the UI before this call). */
  async start(input: AutomationConfig, presetId: Id | null = null, options: { scheduleId?: Id } = {}): Promise<AutomationRun> {
    const config = parseConfig(input)
    // The same campaign sent twice (a repeated click or request) starts once while the first is still
    // going: each new campaign from the form has its own seed, so only a repeat matches.
    const startKey = JSON.stringify(config)
    const previous = !options.scheduleId && this.lastStart?.key === startKey ? this.deps.db.get<{ status: string }>('SELECT status FROM automation_runs WHERE id = :id', { id: this.lastStart.runId }) : null
    if (previous && !['completed', 'stopped', 'failed'].includes(previous.status)) throw new ConflictError('This campaign was just started. Its progress is shown in the campaign status.')
    const plan = this.plan(config)
    const blocking = plan.problems.find((p) => p.blocking)
    if (blocking) throw new ValidationError(blocking.message)
    const busy = this.deps.db.get<{ id: string }>(`SELECT id FROM automation_runs WHERE status IN ('generating', 'awaiting-approval', 'paused') LIMIT 1`)
    if (busy) throw new ConflictError('Another automation run is still active. Stop it or finish its approvals first.')

    // Account records for profiles that have none (only when the user allowed unconfirmed identities).
    if (!config.targets.requireConfirmedIdentity && config.targets.createMissingAccounts) {
      const missing = plan.targets.filter((t) => t.eligible && !t.accountId).map((t) => t.profileId)
      if (missing.length) this.deps.accountService.createFromProfiles(missing)
    }
    const targets = plan.targets.filter((t) => t.eligible).map((t) => ({ ...t, accountId: t.accountId ?? this.deps.accounts.byProfile(t.profileId)?.id ?? null }))

    const now = this.now().toISOString()
    const runId = randomUUID()
    const publishing = config.actions.publish && config.targets.distribution !== 'drafts'
    const start = this.now()
    const end = config.schedule.endAt ? new Date(config.schedule.endAt) : null
    this.deps.db.transaction(() => {
      this.deps.db.run(
        `INSERT INTO automation_runs (id, name, mode, status, config, preset_id, schedule_id, message, created_at, updated_at) VALUES (:id, :name, :mode, 'generating', :config, :presetId, :scheduleId, NULL, :now, :now)`,
        { id: runId, name: config.name, mode: config.mode, config: JSON.stringify(config), presetId, scheduleId: options.scheduleId ?? null, now }
      )
      let position = 0
      // Your drafts take the first texts: per slot for "same" (every profile posts it), per post otherwise.
      const draftIds = config.content.source === 'generate' ? [] : this.usableDrafts(config.content.draftIds).slice(0, plan.fromDrafts).map((d) => d.id)
      const add = (item: { profileId: string | null; accountId: string | null; runAt: string | null; kind: 'post' | 'engagement'; sourceDraftId?: string | null }) =>
        this.deps.db.run(
          `INSERT INTO run_items (id, run_id, position, kind, status, profile_id, account_id, run_at, source_draft_id, created_at, updated_at)
           VALUES (:id, :runId, :position, :kind, 'pending', :profileId, :accountId, :runAt, :sourceDraftId, :now, :now)`,
          { id: randomUUID(), runId, position: position++, kind: item.kind, profileId: item.profileId, accountId: item.accountId, runAt: item.runAt, sourceDraftId: item.sourceDraftId ?? null, now }
        )
      if (config.actions.publish || config.actions.saveDrafts) {
        if (!publishing) {
          for (let i = 0; i < plan.posts; i++) add({ profileId: null, accountId: null, runAt: null, kind: 'post' })
        } else {
          // Exactly the assignment the preview showed (same targets in the same random order).
          for (const slot of this.postSlots(config, targets, start, end, draftIds, plan.posts)) add({ ...slot, kind: 'post' })
        }
      }
    })
    this.deps.log.info('Automation run started', { mode: config.mode, posts: plan.posts, profiles: targets.length, images: config.content.generateImages })
    if (!options.scheduleId) this.lastStart = { key: startKey, runId }

    // Engagement tasks: one account per post link (guardrails apply), done by the user.
    const engagementCount = this.planEngagement(runId, config, targets)

    if (this.deps.queue.paused && publishing && config.mode === 'full-auto') this.deps.queue.resume()
    this.deps.notifier.notify({ tone: 'info', event: 'systemNotices', title: 'Automation started', body: this.startBody(plan, engagementCount), to: '/campaigns' })
    if (plan.profiles.unavailable) {
      this.deps.notifier.notify({ tone: 'warning', event: 'taskFailures', title: `${plan.profiles.unavailable} ${plan.profiles.unavailable === 1 ? 'profile is' : 'profiles are'} unavailable`, body: 'They were left out of this run.', to: '/accounts?view=profiles' })
    }
    this.deps.onChange()
    void this.process(runId)
    return this.details(runId).run
  }

  pause(runId: Id): AutomationRun {
    const run = this.requireRun(runId)
    if (!ACTIVE.includes(run.status) && run.status !== 'publishing') throw new ConflictError('This run is not active.')
    this.setStatus(runId, 'paused', 'Paused by you.')
    this.deps.queue.pause()
    this.deps.notifier.notify({ tone: 'info', event: 'systemNotices', title: 'Automation paused', body: 'Waiting posts stay in the queue until you resume.', to: '/campaigns' })
    return this.details(runId).run
  }

  resume(runId: Id): AutomationRun {
    const run = this.requireRun(runId)
    if (run.status !== 'paused') throw new ConflictError('This run is not paused.')
    this.failuresInRow.set(runId, 0)
    this.deps.db.run("UPDATE run_items SET status = 'pending', updated_at = :now WHERE run_id = :runId AND status = 'generating'", { runId, now: this.now().toISOString() })
    this.setStatus(runId, 'generating', null)
    this.deps.queue.resume()
    this.deps.notifier.notify({ tone: 'info', event: 'systemNotices', title: 'Automation resumed', to: '/campaigns' })
    void this.process(runId)
    return this.details(runId).run
  }

  /** Stops the run: nothing more is generated, and its posts that haven't started publishing are cancelled. */
  async stop(runId: Id): Promise<AutomationRun> {
    const run = this.requireRun(runId)
    if (run.status === 'completed' || run.status === 'stopped') return run
    this.setStatus(runId, 'stopped', 'Stopped by you.')
    const now = this.now().toISOString()
    this.deps.db.run("UPDATE run_items SET status = 'skipped', error = 'Stopped before it was generated.', updated_at = :now WHERE run_id = :runId AND status IN ('pending', 'generating')", { runId, now })
    let cancelled = 0
    for (const item of this.rows(runId)) {
      if (item.status === 'awaiting-approval') {
        this.updateItem(item.id, { status: 'saved', error: 'Not approved before the run was stopped — kept as a draft.' })
        continue
      }
      if (!item.schedule_id) continue
      const schedule = this.deps.db.get<{ status: ScheduleStatus }>('SELECT status FROM scheduled_posts WHERE id = :id', { id: item.schedule_id })
      if (!schedule || !['pending', 'queued', 'missed'].includes(schedule.status)) continue
      try {
        await this.deps.publishing.unschedule(item.schedule_id)
        this.updateItem(item.id, { status: 'skipped', error: 'Cancelled when the run was stopped.' })
        cancelled++
      } catch {
        // Already publishing: it finishes; the outcome is recorded as usual.
      }
    }
    // Comments and reposts that haven't started don't go out either (a running one finishes).
    for (const { id } of this.deps.db.all<{ id: string }>(
      `SELECT t.id FROM tasks t JOIN run_items i ON i.draft_id = t.draft_id AND i.kind = 'post'
       WHERE i.run_id = :runId AND t.kind = 'reply' AND t.status = 'queued'
       UNION SELECT t.id FROM tasks t JOIN run_items i ON t.idempotency_key = 'engage:' || i.engagement_task_id
       WHERE i.run_id = :runId AND i.kind = 'engagement' AND t.status = 'queued'`,
      { runId }
    )) {
      try {
        this.deps.queue.cancel(id)
      } catch {
        // It started in the meantime; its outcome is recorded as usual.
      }
    }
    this.finish(runId, 'stopped')
    this.deps.notifier.notify({ tone: 'info', event: 'systemNotices', title: 'Automation stopped', body: cancelled ? `${cancelled} waiting ${cancelled === 1 ? 'post was' : 'posts were'} cancelled and returned to your drafts.` : undefined, to: '/campaigns' })
    return this.details(runId).run
  }

  /** Switching mode keeps every draft, image, schedule and task. To Full Auto: waiting approvals are approved. */
  async setMode(runId: Id, mode: AutomationMode): Promise<AutomationRun> {
    const run = this.requireRun(runId)
    if (run.status === 'completed' || run.status === 'stopped') throw new ConflictError('This run has finished.')
    const config = { ...run.config, mode }
    this.deps.db.run('UPDATE automation_runs SET mode = :mode, config = :config, updated_at = :now WHERE id = :id', { id: runId, mode, config: JSON.stringify(config), now: this.now().toISOString() })
    if (mode === 'full-auto') {
      const waiting = this.rows(runId).filter((i) => i.status === 'awaiting-approval').map((i) => i.id)
      if (waiting.length) await this.approve(runId, waiting)
    }
    this.deps.onChange()
    return this.details(runId).run
  }

  // ── approvals (Manual Approval mode) ─────────────────────────────────────

  async approve(runId: Id, itemIds: Id[]): Promise<{ approved: number; failed: { id: Id; reason: string }[] }> {
    const run = this.requireRun(runId)
    const result = { approved: 0, failed: [] as { id: Id; reason: string }[] }
    for (const id of new Set(itemIds)) {
      const item = this.rows(runId).find((i) => i.id === id)
      if (!item || item.status !== 'awaiting-approval') {
        result.failed.push({ id, reason: 'Not waiting for approval.' })
        continue
      }
      try {
        await this.scheduleItem(run.config, item)
        result.approved++
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Could not be scheduled.'
        this.updateItem(item.id, { error: reason })
        result.failed.push({ id, reason })
      }
    }
    this.afterItemsChanged(runId)
    return result
  }

  remove(runId: Id, itemIds: Id[]): number {
    this.requireRun(runId)
    let removed = 0
    for (const id of new Set(itemIds)) {
      removed += this.deps.db.run("UPDATE run_items SET status = 'removed', updated_at = :now WHERE id = :id AND run_id = :runId AND status IN ('awaiting-approval', 'pending', 'failed')", {
        id,
        runId,
        now: this.now().toISOString()
      }).changes
    }
    this.afterItemsChanged(runId)
    return removed
  }

  /** New text (and image, when enabled) for a post waiting for approval. The old draft text is replaced. */
  async regenerate(runId: Id, itemId: Id): Promise<RunItem> {
    const run = this.requireRun(runId)
    const item = this.rows(runId).find((i) => i.id === itemId)
    if (!item || (item.status !== 'awaiting-approval' && item.status !== 'failed')) throw new ConflictError('Only posts waiting for approval can be regenerated.')
    if (item.source_draft_id) throw new ConflictError('This post is one of your drafts. Edit it instead of regenerating it.')
    const texts = run.config.content.generateText ? await this.generateTexts(run.config, 1, new Set(this.existingTexts(runId))) : [run.config.content.fixedText]
    if (!texts.length) throw new ValidationError('No new text could be generated. Check your AI provider in Settings.')
    await this.buildDraft(runId, run.config, item, texts[0]!, true)
    this.updateItem(item.id, { status: 'awaiting-approval', error: null })
    this.deps.onChange()
    return this.items(runId).find((i) => i.id === itemId)!
  }

  /** At start-up: a run that was generating when the app closed is paused (nothing is generated twice). */
  recover(): void {
    const now = this.now().toISOString()
    const runs = this.deps.db.all<{ id: string }>("SELECT id FROM automation_runs WHERE status = 'generating'")
    for (const { id } of runs) {
      this.deps.db.run("UPDATE run_items SET status = 'pending', updated_at = :now WHERE run_id = :id AND status = 'generating'", { id, now })
      this.setStatus(id, 'paused', 'Paused because X Auto closed while posts were being prepared.')
    }
    if (runs.length) {
      this.deps.notifier.notify({ tone: 'info', event: 'systemNotices', title: 'Automation paused', body: 'X Auto closed while posts were being prepared. Resume the run to continue.', to: '/campaigns' })
    }
    for (const r of this.deps.db.all<{ id: string }>("SELECT id FROM automation_runs WHERE status = 'publishing'")) this.checkFinished(r.id)
  }

  // ── pipeline ─────────────────────────────────────────────────────────────

  private async process(runId: Id): Promise<void> {
    if (this.processing.has(runId)) return
    this.processing.add(runId)
    try {
      for (;;) {
        const run = this.requireRun(runId)
        if (run.status !== 'generating') return
        const allPending = this.rows(runId).filter((i) => i.status === 'pending' && i.kind === 'post')
        if (!allPending.length) break
        const config = run.config
        // Posts from your own drafts first (nothing to generate except a missing image).
        const fromDrafts = allPending.filter((i) => i.source_draft_id)
        if (fromDrafts.length) {
          const outcome = await this.useDrafts(runId, config, fromDrafts)
          if (outcome === 'stop') return
          continue
        }
        const pending = allPending
        // "same": every profile gets the same texts — one generation per slot, shared.
        const groups = config.targets.distribution === 'same' ? this.groupBySlot(pending) : pending.slice(0, MAX_BATCH).map((i) => [i])
        const batch = config.targets.distribution === 'same' ? groups.slice(0, MAX_BATCH) : groups
        for (const group of batch) for (const item of group) this.updateItem(item.id, { status: 'generating' })
        this.deps.onChange()

        let texts: string[]
        if (!config.content.generateText) texts = batch.map(() => config.content.fixedText)
        else texts = await this.generateTexts(config, batch.length, new Set(this.existingTexts(runId)))

        if (this.requireRun(runId).status !== 'generating') {
          this.deps.db.run("UPDATE run_items SET status = 'pending', updated_at = :now WHERE run_id = :runId AND status = 'generating'", { runId, now: this.now().toISOString() })
          return
        }
        if (texts.length === 0) {
          const message = 'The AI provider didn’t return usable posts.'
          if (config.failure.onTextFailure === 'pause') {
            for (const group of batch) for (const item of group) this.updateItem(item.id, { status: 'pending' })
            this.pauseFor(runId, 'Paused: the AI provider didn’t return usable posts. Check Settings → AI providers & keys, then resume.')
            return
          }
          for (const group of batch) for (const item of group) this.updateItem(item.id, { status: 'failed', error: message })
          this.countFailure(runId, batch.length)
          continue
        }
        let made = 0
        for (let g = 0; g < batch.length; g++) {
          const group = batch[g]!
          const text = texts[g]
          if (!text) {
            for (const item of group) this.updateItem(item.id, { status: 'pending' })
            continue
          }
          const shared = { assetId: null as string | null, failed: false }
          for (const item of group) {
            const outcome = await this.buildDraft(runId, config, item, text, false, shared)
            if (outcome === 'paused') {
              // The rest of this batch goes back to waiting; nothing half-made is published.
              this.deps.db.run("UPDATE run_items SET status = 'pending', updated_at = :now WHERE run_id = :runId AND status = 'generating'", { runId, now: this.now().toISOString() })
              return
            }
            if (outcome === 'ok') {
              made++
              await this.afterDraft(config, item)
            }
          }
        }
        if (made) {
          this.failuresInRow.set(runId, 0)
          const withImages = config.content.generateImages
          this.deps.notifier.notify(
            {
              tone: 'success',
              event: 'systemNotices',
              title: withImages ? `${made} ${made === 1 ? 'post' : 'posts'} generated with images` : `${made} ${made === 1 ? 'post' : 'posts'} generated and saved`,
              body: config.mode === 'manual-approval' && config.actions.publish && config.targets.distribution !== 'drafts' ? 'Waiting for your approval.' : undefined,
              to: '/campaigns'
            },
            { key: `run-progress:${runId}`, quietMs: 30_000 }
          )
        }
        this.deps.onChange()
      }
      this.afterItemsChanged(runId)
    } catch (error) {
      this.deps.log.error('Automation run stopped unexpectedly', error)
      this.pauseFor(runId, 'Paused after an unexpected problem. Resume to try again.')
    } finally {
      this.processing.delete(runId)
    }
  }

  /**
   * Posts from the user's drafts: the text is never changed. With "same", the first profile posts
   * the draft itself and every other profile an independent copy (each post needs its own draft).
   */
  private async useDrafts(runId: Id, config: AutomationConfig, items: ItemRow[]): Promise<'ok' | 'stop'> {
    let made = 0
    for (const item of items.slice(0, MAX_BATCH)) {
      if (this.requireRun(runId).status !== 'generating') return 'stop'
      this.updateItem(item.id, { status: 'generating' })
      // Resumed after a restart: this item already has its own post (and maybe its schedule). It is
      // reused — copying it again would publish the same post twice from this account.
      if (item.draft_id) {
        made++
        await this.afterDraft(config, this.rows(runId).find((i) => i.id === item.id)!)
        continue
      }
      // The first post of a draft uses the draft itself; any further one ("same") copies it.
      const built = this.rows(runId).find((i) => i.id !== item.id && i.source_draft_id === item.source_draft_id && i.draft_id)
      const outcome = await this.buildFromDraft(runId, config, item, built?.draft_id ?? null)
      if (outcome === 'paused') {
        this.deps.db.run("UPDATE run_items SET status = 'pending', updated_at = :now WHERE run_id = :runId AND status = 'generating'", { runId, now: this.now().toISOString() })
        return 'stop'
      }
      if (outcome === 'ok') {
        made++
        await this.afterDraft(config, this.rows(runId).find((i) => i.id === item.id)!)
      }
    }
    if (made) {
      this.failuresInRow.set(runId, 0)
      this.deps.notifier.notify(
        {
          tone: 'success',
          event: 'systemNotices',
          title: `${made} of your ${made === 1 ? 'draft is' : 'drafts are'} ready`,
          body: config.mode === 'manual-approval' ? 'Waiting for your approval.' : undefined,
          to: '/campaigns'
        },
        { key: `run-progress:${runId}`, quietMs: 30_000 }
      )
    }
    this.deps.onChange()
    return 'ok'
  }

  private async buildFromDraft(runId: Id, config: AutomationConfig, item: ItemRow, copyOf: Id | null): Promise<'ok' | 'skipped' | 'paused'> {
    let draft
    try {
      draft = copyOf ? await this.deps.drafts.duplicate(copyOf) : await this.deps.drafts.get(item.source_draft_id!)
    } catch {
      this.updateItem(item.id, { status: 'failed', error: 'This draft was deleted.' })
      this.countFailure(runId)
      return 'skipped'
    }
    if (!copyOf && draft.status !== 'draft' && draft.status !== 'ready') {
      this.updateItem(item.id, { status: 'failed', error: 'This draft was scheduled or published elsewhere, so it was left out.' })
      this.countFailure(runId)
      return 'skipped'
    }
    let image: RunItem['image'] = draft.media.length ? 'attached' : 'none'
    let attachments: { assetId: string; altText: string }[] | undefined
    if (!draft.media.length) {
      if (config.content.generateImages) {
        const assetId = await this.generateImage(config, composePost(draft.body, draft.hashtags))
        if (assetId) {
          attachments = [{ assetId, altText: '' }]
          image = 'attached'
        } else if (config.failure.onImageFailure === 'pause') {
          this.updateItem(item.id, { status: 'pending', image: 'failed' })
          this.pauseFor(runId, 'Paused: an image could not be generated. Check your image provider, then resume.')
          return 'paused'
        } else if (config.failure.onImageFailure === 'skip') {
          this.updateItem(item.id, { status: 'failed', image: 'failed', error: 'The image could not be generated, so this post was skipped.' })
          this.countFailure(runId)
          return 'skipped'
        } else image = 'skipped'
      } else if (config.content.existingAssetId) {
        attachments = [{ assetId: config.content.existingAssetId, altText: '' }]
        image = 'attached'
      }
    }
    const saved = await this.deps.drafts.save({ id: draft.id, body: draft.body, hashtags: draft.hashtags, accountId: item.account_id, status: 'ready', ...(attachments ? { attachments } : {}) })
    if (image === 'attached' && !saved.media.some((m) => m.available)) image = 'failed'
    this.updateItem(item.id, { draft_id: saved.id, image, error: image === 'skipped' ? 'Published without an image (image generation failed).' : null })
    return 'ok'
  }

  /** Drafts that can go into a run, in the order given: still drafts, not scheduled or published. */
  private usableDrafts(ids: Id[]): { id: Id; hasMedia: boolean; hasComment: boolean }[] {
    if (!ids.length) return []
    const rows = this.deps.db.all<{ id: string; media: number; comment: number }>(
      `SELECT d.id, (SELECT COUNT(*) FROM draft_attachments a WHERE a.draft_id = d.id) AS media,
         (d.comment_enabled = 1 AND trim(d.comment_text) <> '') AS comment FROM drafts d
       WHERE d.id IN (SELECT value FROM json_each(:ids)) AND d.status IN ('draft', 'ready')
         AND NOT EXISTS (SELECT 1 FROM scheduled_posts s WHERE s.draft_id = d.id AND s.status IN ('pending', 'queued', 'missed', 'needs-review'))`,
      { ids: JSON.stringify(ids) }
    )
    const byId = new Map(rows.map((r) => [r.id, r]))
    return [...new Set(ids)].filter((id) => byId.has(id)).map((id) => ({ id, hasMedia: byId.get(id)!.media > 0, hasComment: byId.get(id)!.comment === 1 }))
  }

  /** Text generation with retries; returns up to `count` new, distinct posts within the length limit. */
  private async generateTexts(config: AutomationConfig, count: number, seen: Set<string>): Promise<string[]> {
    const out: string[] = []
    for (let attempt = 0; attempt <= config.failure.generationRetries && out.length < count; attempt++) {
      const brief: GenerationBrief = {
        topic: (config.content.topic.trim() || config.content.prompt.trim()).slice(0, 200),
        keyPoints: config.content.prompt.trim().slice(0, 2000),
        audience: '',
        tone: config.content.tone,
        language: config.content.language,
        length: config.content.length,
        variations: Math.min(Math.max(count - out.length, 1), MAX_BATCH),
        hashtags: config.content.hashtags,
        suggestHashtags: config.content.suggestHashtags,
        callToAction: '',
        instructions: [config.content.instructions.trim(), SAFE_INSTRUCTIONS].filter(Boolean).join('\n').slice(0, 2000),
        lengthProfile: 'standard'
      }
      let record
      try {
        record = await this.deps.generator.generate(brief, { requestId: randomUUID(), providerId: config.content.textProviderId ?? undefined, model: config.content.textModel ?? undefined })
      } catch (error) {
        this.deps.log.warn('Post generation failed', { reason: error instanceof Error ? error.name : 'unknown' })
        continue
      }
      if (record.status !== 'succeeded') {
        const kind = record.error?.kind
        if (kind === 'auth' || kind === 'network' || kind === 'not-configured' || kind === 'quota' || kind === 'usage-limit') {
          this.deps.notifier.notify(
            {
              tone: 'danger',
              event: 'taskFailures',
              title: kind === 'usage-limit' ? 'AI usage limit reached' : 'AI provider connection failed. Check settings.',
              body: record.error?.message,
              to: kind === 'usage-limit' ? '/settings?section=usage' : '/settings?section=ai'
            },
            { key: `ai-text:${kind}` }
          )
          break
        }
        continue
      }
      for (const result of record.results) {
        const text = result.trim()
        const key = text.toLowerCase().replace(/\s+/g, ' ')
        if (!text || seen.has(key)) continue
        if (measurePost(composePost(text, config.content.hashtags), LENGTH_PROFILES.standard.maxWeighted).isOver) continue
        seen.add(key)
        out.push(text)
        if (out.length >= count) break
      }
    }
    return out
  }

  /**
   * Saves a draft with its text and (when enabled) a generated image that is
   * actually on disk. Returns 'ok', 'skipped' (item marked) or 'paused' (run paused).
   */
  private async buildDraft(
    runId: Id,
    config: AutomationConfig,
    item: ItemRow,
    text: string,
    replace: boolean,
    shared: { assetId: string | null; failed: boolean } = { assetId: null, failed: false }
  ): Promise<'ok' | 'skipped' | 'paused'> {
    let assetId: string | null = config.content.generateImages ? shared.assetId : config.content.existingAssetId
    let image: RunItem['image'] = assetId ? 'attached' : 'none'
    if (config.content.generateImages && !assetId && !shared.failed) {
      assetId = await this.generateImage(config, text)
      shared.assetId = assetId
      shared.failed = !assetId
    }
    if (config.content.generateImages && !assetId) {
      if (config.failure.onImageFailure === 'pause') {
        this.updateItem(item.id, { status: 'pending', image: 'failed' })
        this.pauseFor(runId, 'Paused: an image could not be generated. Check your image provider, then resume.')
        return 'paused'
      }
      if (config.failure.onImageFailure === 'skip') {
        this.updateItem(item.id, { status: 'failed', image: 'failed', error: 'The image could not be generated, so this post was skipped.' })
        this.countFailure(runId)
        return 'skipped'
      }
      image = 'skipped' // 'without-image', chosen explicitly by the user
    } else if (assetId) image = 'attached'
    const draft = await this.deps.drafts.save({
      ...(replace && item.draft_id ? { id: item.draft_id } : {}),
      body: text,
      hashtags: config.content.hashtags,
      accountId: item.account_id,
      status: 'ready',
      aiAssisted: config.content.generateText,
      attachments: assetId ? [{ assetId, altText: '' }] : []
    })
    // Never report an image as attached unless the draft really holds it.
    if (assetId && !draft.media.some((m) => m.id === assetId && m.available)) image = 'failed'
    this.updateItem(item.id, { draft_id: draft.id, image, error: image === 'skipped' ? 'Published without an image (image generation failed).' : null })
    return 'ok'
  }

  private async generateImage(config: AutomationConfig, text: string): Promise<string | null> {
    for (let attempt = 0; attempt <= config.failure.generationRetries; attempt++) {
      try {
        const suggestion = await this.deps.images.suggestPrompt({ postText: text, style: config.content.imageStyle, instructions: '', requestId: randomUUID(), providerId: config.content.textProviderId ?? undefined })
        const prompt = suggestion.ok ? suggestion.prompt : `${config.content.imageStyle} image for this post: ${text}`.slice(0, 1000)
        const record = await this.deps.images.generate(
          { prompt, size: config.content.imageSize, quality: null, format: null, transparent: false, count: 1, draftId: null },
          { requestId: randomUUID(), providerId: config.content.imageProviderId ?? undefined, model: config.content.imageModel ?? undefined }
        )
        const asset = record.status === 'succeeded' ? record.assets.find((a) => a.available) : undefined
        if (asset) return asset.id
        if (record.error && ['auth', 'network', 'not-configured', 'quota', 'usage-limit'].includes(record.error.kind)) {
          this.deps.notifier.notify(
            { tone: 'danger', event: 'taskFailures', title: 'Image provider request failed. Check settings.', body: record.error.message, to: '/settings?section=ai' },
            { key: `ai-image:${record.error.kind}` }
          )
          return null
        }
      } catch (error) {
        this.deps.log.warn('Image generation failed', { reason: error instanceof Error ? error.name : 'unknown' })
      }
    }
    return null
  }

  /** After a draft is ready: schedule it (Full Auto), keep it for approval, or keep it as a draft. */
  private async afterDraft(config: AutomationConfig, item: ItemRow): Promise<void> {
    const fresh = this.rows(item.run_id).find((i) => i.id === item.id)!
    const publishing = config.actions.publish && config.targets.distribution !== 'drafts' && fresh.account_id
    if (!publishing) return this.updateItem(item.id, { status: 'saved' })
    if (config.mode === 'manual-approval') return this.updateItem(item.id, { status: 'awaiting-approval' })
    try {
      await this.scheduleItem(config, fresh)
    } catch (error) {
      this.updateItem(item.id, { status: 'failed', error: error instanceof Error ? error.message : 'Could not be scheduled.' })
      this.countFailure(item.run_id)
    }
  }

  private async scheduleItem(config: AutomationConfig, item: ItemRow): Promise<void> {
    if (!item.draft_id || !item.account_id) throw new ValidationError('This post has no draft or account.')
    // Once per post and account: a schedule this item's post already has (from before a restart) is
    // kept instead of making another one.
    const existing = this.deps.db.get<{ id: string }>(
      "SELECT id FROM scheduled_posts WHERE draft_id = :draftId AND account_id = :accountId AND status <> 'cancelled' ORDER BY created_at DESC LIMIT 1",
      { draftId: item.draft_id, accountId: item.account_id }
    )
    if (existing) return this.updateItem(item.id, { status: 'scheduled', schedule_id: existing.id, error: null })
    const due = item.run_at ? new Date(item.run_at) : this.now()
    const soon = due.getTime() <= this.now().getTime() + 60_000
    const entry = soon
      ? await this.deps.publishing.publishNow({ draftId: item.draft_id, accountId: item.account_id })
      : await this.deps.publishing.schedule({ draftId: item.draft_id, accountId: item.account_id, runAt: due.toISOString() })
    this.updateItem(item.id, { status: 'scheduled', schedule_id: entry.schedule.id, error: null })
    void config
  }

  /**
   * Which one of your accounts acts on each selected post (or why the post is skipped). Accounts take
   * turns, so the selected posts are spread over your accounts; each post gets one account only, and
   * a comment goes on one post only. Saved comments (bulk comments) are paired with posts: a comment's
   * own target first, then the selected posts in order — one comment per post, never a made-up
   * target. Used for the preview and, unchanged, by Start.
   */
  private engagementAssignments(config: AutomationConfig, accounts: string[]): EngagementAssignment[] {
    const links = [...new Map(config.actions.engagementLinks.map((l) => parsePostUrl(l)).filter((l): l is ParsedPostUrl => Boolean(l)).map((l) => [l.postId, l])).values()]
    const kinds = [config.actions.repost && 'repost', config.actions.comment && 'reply', config.actions.like && 'like'].filter(Boolean) as ('repost' | 'reply' | 'like')[]
    // Campaigns run now: their reposts and comments have no due time.
    const dueAt: string | null = null
    const saved = config.actions.comment && config.actions.commentIds?.length ? this.comments.byIds(config.actions.commentIds) : null
    const out: EngagementAssignment[] = []
    let turn = 0
    let commented = false
    const linkIdOf = (parsed: ParsedPostUrl) => this.deps.db.get<{ id: string }>('SELECT id FROM post_links WHERE url = :url OR post_id = :postId', { url: parsed.url, postId: parsed.postId })?.id ?? null
    const assign = (parsed: ParsedPostUrl, kind: 'repost' | 'reply' | 'like', text: string | null, commentId: string | null) => {
      const linkId = linkIdOf(parsed)
      const base = { url: parsed.url, postId: parsed.postId, handle: parsed.handle, linkId, kind, dueAt, text, commentId }
      if (!accounts.length) return out.push({ ...base, accountId: null, skipped: 'Skipped: none of your synchronized profiles can be used.' })
      // One account per post and kind — several of your accounts on one post is coordinated engagement.
      let chosen: string | null = null
      let reason: string | null = null
      // A post by one of your accounts may only be reposted/liked by that same account (else it is
      // artificial amplification) — checked here too for posts not yet in Post Links.
      const owner = !linkId && kind !== 'reply' && parsed.handle ? this.deps.accounts.byHandle(parsed.handle) : null
      for (let i = 0; i < accounts.length; i++) {
        const accountId = accounts[(turn + i) % accounts.length]!
        if (!linkId) {
          if (owner && owner.id !== accountId) {
            reason ??= `This post is from ${owner.label}, one of your accounts — only that account may ${kind === 'repost' ? 'repost' : 'like'} it.`
            continue
          }
          chosen = accountId
          break
        }
        const check = this.deps.engagement.check({ linkId, accountId, kind, dueAt, note: '', replyText: text ?? '' })
        const blocking = check.problems.find((p) => p.blocking)
        if (!blocking) {
          chosen = accountId
          break
        }
        reason ??= blocking.message
      }
      if (chosen) {
        turn++
        if (kind === 'reply') commented = true
      }
      return out.push({ ...base, accountId: chosen, skipped: chosen ? null : `Skipped: ${reason ?? 'no account can take it.'}` })
    }

    for (const parsed of links) {
      for (const kind of kinds) {
        if (kind === 'reply' && saved) continue
        if (kind === 'reply' && commented) {
          out.push({ url: parsed.url, postId: parsed.postId, handle: parsed.handle, linkId: linkIdOf(parsed), kind, dueAt, text: config.actions.commentText.trim(), commentId: null, accountId: null, skipped: 'Skipped: the same comment goes on one post only. Write a separate comment for this post.' })
          continue
        }
        assign(parsed, kind, kind === 'reply' ? config.actions.commentText.trim() : null, null)
      }
    }
    if (saved) {
      for (const pair of pairComments(saved, links)) {
        if (pair.target && pair.comment) assign(pair.target, 'reply', pair.comment.body, pair.comment.id)
        else if (pair.comment) out.push({ url: '', postId: '', handle: null, linkId: null, kind: 'reply', dueAt, text: pair.comment.body, commentId: pair.comment.id, accountId: null, skipped: pair.reason })
        else if (pair.target) out.push({ url: pair.target.url, postId: pair.target.postId, handle: pair.target.handle, linkId: linkIdOf(pair.target), kind: 'reply', dueAt, text: null, commentId: null, accountId: null, skipped: pair.reason })
      }
    }
    return out
  }

  /**
   * Which account posts what, and when. Round-robin over the targets (already in the campaign's random
   * order): with as many accounts as posts, every post gets a different account; with more posts than
   * accounts, an account gets a second one only after every account has one. "same" (every post from
   * every account) is kept for older saved setups. Used for the preview and, unchanged, by Start.
   */
  private postSlots(config: AutomationConfig, targets: { profileId: string; accountId: string | null }[], start: Date, end: Date | null, draftIds: string[], maxPosts: number): { profileId: string; accountId: string | null; runAt: string; sourceDraftId: string | null }[] {
    const out: { profileId: string; accountId: string | null; runAt: string; sourceDraftId: string | null }[] = []
    for (let slot = 0; slot < config.schedule.postsPerProfile && out.length < maxPosts; slot++) {
      for (const target of targets) {
        if (out.length >= maxPosts) break
        const at = slotTime(config, start, slot)
        if (end && at > end) continue
        const sourceDraftId = (config.targets.distribution === 'same' ? draftIds[slot] : draftIds[out.length]) ?? null
        if (config.content.source === 'drafts' && !sourceDraftId) continue
        out.push({ profileId: target.profileId, accountId: target.accountId, runAt: at.toISOString(), sourceDraftId })
      }
    }
    return out
  }

  private planEngagement(runId: Id, config: AutomationConfig, targets: { accountId: string | null }[]): number {
    const accounts = targets.map((t) => t.accountId).filter((a): a is string => Boolean(a))
    if (!accounts.length) return 0
    let created = 0
    // Exactly the assignment the preview showed.
    for (const assignment of this.engagementAssignments(config, accounts)) {
      if (!assignment.accountId) continue
      const { kind, accountId, dueAt } = assignment
      const parsed = { url: assignment.url, postId: assignment.postId, handle: assignment.handle }
      // The link is saved (or found) in Post Links first — looked up again, since an earlier assignment
      // in this loop (another action on the same new post) may have just saved it.
      const saved = assignment.linkId ?? this.deps.db.get<{ id: string }>('SELECT id FROM post_links WHERE url = :url OR post_id = :postId', { url: parsed.url, postId: parsed.postId })?.id ?? null
      const linkId = saved ?? randomUUID()
      if (!saved) {
        const now = this.now().toISOString()
        this.deps.db.run(
          `INSERT INTO post_links (id, url, post_id, handle, account_id, draft_id, task_id, source, preview, published_at, created_at, updated_at, notes, tags)
           VALUES (:id, :url, :postId, :handle, NULL, NULL, NULL, 'manual', '', NULL, :now, :now, '', '[]')`,
          { id: linkId, url: parsed.url, postId: parsed.postId, handle: parsed.handle, now }
        )
      }
      {
        {
          const replyText = kind === 'reply' ? (assignment.text ?? '') : ''
          const result = this.deps.engagement.create({ linkIds: [linkId], accountId, kind, dueAt, note: `From campaign “${config.name}”`, replyText })
          if (result.created.length) {
            const task = result.created[0]!
            // Reposts and comments run in the persistent task queue at the chosen time (never earlier),
            // through the account's profile, and count only once X confirmed them. Likes stay tasks for you.
            const automatic = kind === 'repost' || kind === 'reply'
            const now = this.now().toISOString()
            this.deps.db.transaction(() => {
              this.deps.db.run(
                `INSERT INTO run_items (id, run_id, position, kind, status, account_id, engagement_task_id, run_at, created_at, updated_at)
                 VALUES (:id, :runId, (SELECT COALESCE(MAX(position), -1) + 1 FROM run_items WHERE run_id = :runId), 'engagement', :status, :accountId, :taskId, :runAt, :now, :now)`,
                { id: randomUUID(), runId, accountId, taskId: task.id, status: automatic ? 'scheduled' : 'saved', runAt: automatic ? (dueAt ?? now) : null, now }
              )
              if (!automatic) return
              this.deps.queue.enqueue({
                kind: kind === 'repost' ? 'repost' : 'reply',
                accountId,
                draftId: null,
                scheduleId: null,
                label: kind === 'repost' ? 'Repost' : 'Comment on a post',
                payload: kind === 'repost' ? { engagementTaskId: task.id, url: parsed.url, dueAt } : { engagementTaskId: task.id, parentPostId: parsed.postId, parentUrl: parsed.url, text: replyText.trim(), dueAt },
                // One queue task per engagement task: a retry or a restart never repeats it.
                idempotencyKey: `engage:${task.id}`,
                maxAttempts: this.deps.publishing.getSettings().maxAttempts,
                runAfter: dueAt ?? now
              })
              // A saved comment is used once it is planned (it shows as used; choosing it again is up to you).
              if (assignment.commentId) this.comments.markUsed([assignment.commentId], now)
            })
            created++
          }
        }
      }
    }
    return created
  }

  // ── bookkeeping ──────────────────────────────────────────────────────────

  /** Groups posts by slot (the n-th post of each profile), so "same" shares one text per slot. */
  private groupBySlot(items: ItemRow[]): ItemRow[][] {
    const slotOf = new Map<string, number>()
    const seen = new Map<string, number>()
    for (const row of items[0] ? this.rows(items[0].run_id) : []) {
      if (row.kind !== 'post') continue
      const key = row.profile_id ?? row.id
      const n = seen.get(key) ?? 0
      slotOf.set(row.id, n)
      seen.set(key, n + 1)
    }
    const map = new Map<string, ItemRow[]>()
    for (const item of items) {
      const key = `s${slotOf.get(item.id) ?? item.position}`
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(item)
    }
    return [...map.values()]
  }

  private existingTexts(runId: Id): string[] {
    return this.deps.db
      .all<{ body: string }>('SELECT d.body FROM run_items i JOIN drafts d ON d.id = i.draft_id WHERE i.run_id = :runId', { runId })
      .map((r) => r.body.trim().toLowerCase().replace(/\s+/g, ' '))
  }

  private countFailure(runId: Id, n = 1): void {
    const run = this.deps.db.get<{ status: RunStatus; config: string }>('SELECT status, config FROM automation_runs WHERE id = :id', { id: runId })
    if (!run) return
    const limit = (JSON.parse(run.config) as AutomationConfig).failure.stopAfterFailures
    const count = (this.failuresInRow.get(runId) ?? 0) + n
    this.failuresInRow.set(runId, count)
    if (limit > 0 && count >= limit && run.status !== 'paused' && run.status !== 'stopped' && run.status !== 'completed') {
      this.deps.queue.pause()
      this.pauseFor(runId, `Paused after ${count} failed posts in a row. Check the task queue, then resume.`)
    }
  }

  private pauseFor(runId: Id, message: string): void {
    this.setStatus(runId, 'paused', message)
    this.deps.notifier.notify({ tone: 'warning', event: 'taskFailures', title: 'Automation paused', body: message, to: '/campaigns' }, { key: `run-paused:${runId}`, quietMs: 60_000 })
  }

  private afterItemsChanged(runId: Id): void {
    const run = this.requireRun(runId)
    if (run.status === 'paused' || run.status === 'stopped' || run.status === 'completed') return this.deps.onChange()
    const items = this.rows(runId)
    if (items.some((i) => i.status === 'pending' || i.status === 'generating')) return this.deps.onChange()
    if (items.some((i) => i.status === 'awaiting-approval')) {
      if (run.status !== 'awaiting-approval') {
        this.setStatus(runId, 'awaiting-approval', null)
        const n = items.filter((i) => i.status === 'awaiting-approval').length
        this.deps.notifier.notify({ tone: 'info', event: 'systemNotices', title: `${n} ${n === 1 ? 'post is' : 'posts are'} ready for your approval`, to: '/campaigns' })
      }
      return this.deps.onChange()
    }
    if (items.some((i) => i.status === 'scheduled')) {
      if (run.status !== 'publishing') this.setStatus(runId, 'publishing', null)
      this.checkFinished(runId)
      return
    }
    this.finish(runId, 'completed')
  }

  /** A run is complete once every scheduled post has a final outcome. */
  private checkFinished(runId: Id): void {
    const run = this.deps.db.get<{ status: RunStatus }>('SELECT status FROM automation_runs WHERE id = :id', { id: runId })
    if (!run || run.status !== 'publishing') return this.deps.onChange()
    const open = this.deps.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM run_items i JOIN scheduled_posts s ON s.id = i.schedule_id
       WHERE i.run_id = :runId AND s.status IN ('pending', 'queued', 'missed')`,
      { runId }
    )?.n
    if (open) return this.deps.onChange()
    // Comments still waiting or being posted keep the campaign running.
    const comments = this.deps.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM run_items i JOIN tasks t ON t.kind = 'reply' AND t.draft_id = i.draft_id
       WHERE i.run_id = :runId AND i.kind = 'post' AND t.status IN ('queued', 'running')`,
      { runId }
    )?.n
    if (comments) return this.deps.onChange()
    const engagement = this.deps.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM run_items i JOIN tasks t ON t.idempotency_key = 'engage:' || i.engagement_task_id
       WHERE i.run_id = :runId AND i.kind = 'engagement' AND t.status IN ('queued', 'running')`,
      { runId }
    )?.n
    if (engagement) return this.deps.onChange()
    this.finish(runId, 'completed')
  }

  private finish(runId: Id, requested: 'completed' | 'stopped' | 'failed'): void {
    const now = this.now().toISOString()
    // "Completed" only when something actually went out: a run where every post, repost and comment
    // failed (or still needs review) ends as Failed, never as a false Completed.
    let status = requested
    if (requested === 'completed') {
      const c = this.countsOf(this.items(runId))
      if (c.total > 0 && c.published === 0 && c.saved === 0 && c.failed + c.needsReview > 0) status = 'failed'
    }
    this.deps.db.run('UPDATE automation_runs SET status = :status, finished_at = :now, updated_at = :now WHERE id = :id', { id: runId, status, now })
    if (status === 'completed' || (status === 'failed' && requested === 'completed')) {
      const counts = this.countsOf(this.items(runId))
      this.deps.notifier.notify({
        tone: status === 'failed' ? 'danger' : counts.failed || counts.needsReview ? 'warning' : 'success',
        event: status === 'failed' ? 'taskFailures' : 'systemNotices',
        title: status === 'failed' ? 'Campaign failed' : 'Automation finished',
        body: [
          counts.published && `${counts.published} published`,
          counts.comments.posted && `${counts.comments.posted} ${counts.comments.posted === 1 ? 'comment' : 'comments'} posted`,
          counts.comments.failed && `${counts.comments.failed} ${counts.comments.failed === 1 ? 'comment' : 'comments'} not posted`,
          counts.saved && `${counts.saved} saved`,
          counts.needsReview && `${counts.needsReview} need review`,
          counts.failed && `${counts.failed} failed`
        ]
          .filter(Boolean)
          .join(' · ') || undefined,
        to: '/campaigns'
      })
    }
    this.deps.onChange()
  }

  private startBody(plan: RunPlan, engagement: number): string {
    const parts = [`${plan.posts} ${plan.posts === 1 ? 'post' : 'posts'} for ${plan.profiles.eligible} ${plan.profiles.eligible === 1 ? 'profile' : 'profiles'}`]
    if (plan.images) parts.push('with images')
    if (engagement) parts.push(`${engagement} engagement ${engagement === 1 ? 'task' : 'tasks'} for you`)
    return parts.join(' · ')
  }

  private setStatus(runId: Id, status: RunStatus, message: string | null): void {
    this.deps.db.run('UPDATE automation_runs SET status = :status, message = :message, updated_at = :now WHERE id = :id', { id: runId, status, message, now: this.now().toISOString() })
    this.deps.onChange()
  }

  private updateItem(id: Id, patch: Partial<Pick<ItemRow, 'status' | 'draft_id' | 'schedule_id' | 'image' | 'error'>>): void {
    const sets = Object.keys(patch).map((k) => `${k} = :${k}`)
    this.deps.db.run(`UPDATE run_items SET ${[...sets, 'updated_at = :now'].join(', ')} WHERE id = :id`, { id, now: this.now().toISOString(), ...patch })
  }

  private requireRun(runId: Id): AutomationRun {
    const row = this.deps.db.get<Record<string, string>>('SELECT * FROM automation_runs WHERE id = :id', { id: runId })
    if (!row) throw new NotFoundError('That automation run no longer exists.')
    return this.toRun(row, false)
  }

  private rows(runId: Id): ItemRow[] {
    return this.deps.db.all<ItemRow>('SELECT * FROM run_items WHERE run_id = :runId ORDER BY position', { runId })
  }

  private items(runId: Id): RunItem[] {
    return this.deps.db
      .all<Record<string, unknown>>(
        `SELECT i.*, p.name AS profile_name, a.label AS account_label, d.body AS draft_body,
           (SELECT asset_id FROM draft_attachments da WHERE da.draft_id = i.draft_id ORDER BY position LIMIT 1) AS asset_id,
           s.status AS schedule_status,
           (SELECT t.status FROM tasks t WHERE t.schedule_id = s.id ORDER BY t.created_at DESC LIMIT 1) AS task_status,
           (SELECT l.url FROM post_links l JOIN tasks t ON t.id = l.task_id WHERE t.schedule_id = s.id LIMIT 1) AS post_url,
           e.status AS engagement_status, e.kind AS engagement_kind, l2.url AS engagement_url,
           d.comment_enabled AS comment_enabled, d.comment_text AS comment_text,
           r.status AS reply_status, r.result AS reply_result, r.error AS reply_error,
           g.status AS engage_status, g.error AS engage_error
         FROM run_items i
         LEFT JOIN browser_profiles p ON p.id = i.profile_id
         LEFT JOIN accounts a ON a.id = i.account_id
         LEFT JOIN drafts d ON d.id = i.draft_id
         LEFT JOIN scheduled_posts s ON s.id = i.schedule_id
         LEFT JOIN engagement_tasks e ON e.id = i.engagement_task_id
         LEFT JOIN post_links l2 ON l2.id = e.link_id
         LEFT JOIN tasks r ON r.id = (SELECT id FROM tasks WHERE kind = 'reply' AND draft_id = i.draft_id ORDER BY created_at DESC LIMIT 1)
         LEFT JOIN tasks g ON i.kind = 'engagement' AND g.idempotency_key = 'engage:' || i.engagement_task_id
         WHERE i.run_id = :runId ORDER BY i.position`,
        { runId }
      )
      .map((r) => ({
        id: String(r.id),
        runId: String(r.run_id),
        position: Number(r.position),
        kind: r.kind as RunItem['kind'],
        status: r.status as RunItemStatus,
        profileId: (r.profile_id as string) ?? null,
        profileName: (r.profile_name as string) ?? null,
        accountId: (r.account_id as string) ?? null,
        accountLabel: (r.account_label as string) ?? null,
        draftId: (r.draft_id as string) ?? null,
        fromDraft: Boolean(r.source_draft_id),
        sourceDraftId: (r.source_draft_id as string) ?? null,
        engagementStatus: r.kind === 'engagement' ? ((r.engagement_status as RunItem['engagementStatus']) ?? null) : null,
        text: r.kind === 'engagement' ? `${r.engagement_kind === 'reply' ? 'Comment on' : r.engagement_kind === 'repost' ? 'Repost' : 'Like'} ${String(r.engagement_url ?? '')}` : ((r.draft_body as string) ?? null),
        imageAssetId: (r.asset_id as string) ?? null,
        image: r.image as RunItem['image'],
        scheduleId: (r.schedule_id as string) ?? null,
        scheduleStatus: (r.schedule_status as ScheduleStatus) ?? null,
        taskStatus: ((r.kind === 'engagement' ? r.engage_status : r.task_status) as TaskStatus) ?? null,
        postUrl: r.kind === 'engagement' ? ((r.engagement_url as string) ?? null) : ((r.post_url as string) ?? null),
        comment: r.kind === 'post' && Number(r.comment_enabled) === 1 && String(r.comment_text ?? '').trim() ? this.commentOf(r) : null,
        runAt: (r.run_at as string) ?? null,
        error: (r.kind === 'engagement' ? ((r.engage_error as string) ?? (r.error as string)) : (r.error as string)) ?? null
      }))
  }

  private commentOf(r: Record<string, unknown>): NonNullable<RunItem['comment']> {
    let url: string | null = null
    try {
      url = r.reply_result ? ((JSON.parse(String(r.reply_result)) as { url?: string | null }).url ?? null) : null
    } catch {
      url = null
    }
    return { text: String(r.comment_text).trim(), status: (r.reply_status as TaskStatus) ?? null, url, error: (r.reply_error as string) ?? null }
  }

  private countsOf(items: RunItem[]): RunCounts {
    const c: RunCounts = { total: 0, pending: 0, awaitingApproval: 0, scheduled: 0, published: 0, failed: 0, needsReview: 0, skipped: 0, saved: 0, comments: { total: 0, posted: 0, failed: 0, pending: 0 } }
    for (const i of items) {
      if (i.status === 'removed') continue
      if (i.comment && i.status === 'scheduled' && !['failed', 'cancelled'].includes(i.scheduleStatus ?? '')) {
        c.comments.total++
        if (i.comment.status === 'succeeded') c.comments.posted++
        else if (i.comment.status === 'failed' || i.comment.status === 'cancelled' || i.comment.status === 'needs-review') c.comments.failed++
        else c.comments.pending++
      }
      c.total++
      if (i.status === 'pending' || i.status === 'generating') c.pending++
      else if (i.status === 'awaiting-approval') c.awaitingApproval++
      else if (i.status === 'saved') c.saved++
      else if (i.status === 'skipped') c.skipped++
      else if (i.status === 'failed') c.failed++
      else if (i.status === 'scheduled' && i.kind === 'engagement') {
        // A campaign repost or comment: its own queue task's outcome.
        if (i.taskStatus === 'succeeded') c.published++
        else if (i.taskStatus === 'needs-review') c.needsReview++
        else if (i.taskStatus === 'failed') c.failed++
        else if (i.taskStatus === 'cancelled') c.skipped++
        else c.scheduled++
      } else if (i.status === 'scheduled') {
        if (i.scheduleStatus === 'completed') c.published++
        else if (i.scheduleStatus === 'needs-review') c.needsReview++
        else if (i.scheduleStatus === 'failed') c.failed++
        else if (i.scheduleStatus === 'cancelled') c.skipped++
        else c.scheduled++
      }
    }
    return c
  }

  private toRun(row: Record<string, string>, withCounts = true): AutomationRun {
    return {
      id: row.id!,
      name: row.name!,
      mode: row.mode as AutomationMode,
      status: row.status as RunStatus,
      config: withContentDefaults(JSON.parse(row.config!) as AutomationConfig),
      message: row.message ?? null,
      scheduleId: row.schedule_id ?? null,
      counts: withCounts ? this.countsOf(this.items(row.id!)) : { total: 0, pending: 0, awaitingApproval: 0, scheduled: 0, published: 0, failed: 0, needsReview: 0, skipped: 0, saved: 0, comments: { total: 0, posted: 0, failed: 0, pending: 0 } },
      createdAt: row.created_at!,
      updatedAt: row.updated_at!,
      finishedAt: row.finished_at ?? null
    }
  }

  private textProvider(config: AutomationConfig) {
    const id = config.content.textProviderId ?? this.deps.preferences.get().defaults.textProviderId
    return this.deps.providers.list('openai-compatible').find((p) => p.id === id && p.enabled && p.readiness.state === 'ready') ?? null
  }

  private imageProvider(config: AutomationConfig) {
    const id = config.content.imageProviderId ?? this.deps.preferences.get().defaults.imageProviderId
    return this.deps.providers.list('image').find((p) => p.id === id && p.enabled && p.readiness.state === 'ready') ?? null
  }
}


interface EngagementAssignment {
  url: string
  postId: string
  handle: string | null
  linkId: string | null
  kind: 'repost' | 'reply' | 'like'
  accountId: string | null
  dueAt: string | null
  skipped: string | null
  /** Comments: the text to post and the saved comment it comes from. */
  text: string | null
  commentId: string | null
}

type CommentPair = { comment: { id: string; body: string } | null; target: ParsedPostUrl | null; reason: string | null }

/**
 * Saved comments ↔ posts, one comment per post: a comment with its own target goes on that post;
 * the others take the selected posts in order. Comments without a post and posts without a comment
 * are returned with the reason they are skipped. Never invents a target.
 */
export function pairComments(comments: { id: string; body: string; targetUrl: string | null }[], selected: ParsedPostUrl[]): CommentPair[] {
  const taken = new Set<string>()
  const result: CommentPair[] = comments.map((c) => {
    if (!c.targetUrl) return { comment: c, target: null, reason: null }
    const target = parsePostUrl(c.targetUrl)
    if (!target) return { comment: c, target: null, reason: 'Skipped: its target is not a link to a post on X.' }
    if (taken.has(target.postId)) return { comment: c, target: null, reason: 'Skipped: another selected comment already goes on its target post (one comment per post).' }
    taken.add(target.postId)
    return { comment: c, target, reason: null }
  })
  const free = selected.filter((l) => !taken.has(l.postId))
  let next = 0
  for (const pair of result) {
    if (pair.target || pair.reason) continue
    const target = free[next++]
    if (target) pair.target = target
    else pair.reason = 'Skipped: no post left for this comment — select another post to comment on, or give the comment a target.'
  }
  for (const target of free.slice(next)) result.push({ comment: null, target, reason: 'Skipped: no comment left for this post — select another comment.' })
  return result
}
