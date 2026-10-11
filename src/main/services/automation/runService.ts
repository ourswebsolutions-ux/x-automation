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
import { ConflictError, NotFoundError, ValidationError } from '../errors'
import type { GeneratorService } from '../generator/generatorService'
import type { ImageService } from '../images/imageService'
import type { AccountService } from '../accounts/accountService'
import type { EngagementService } from '../links/engagementService'
import type { ScopedLogger } from '../logging/logger'
import type { Notifier } from '../notifications/notifier'
import type { ProviderService } from '../providers/providerService'
import type { PreferencesStore } from '../preferences/preferencesStore'
import { parsePostUrl } from '../publishing/postUrl'
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
  engagement: Pick<EngagementService, 'create'>
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

/** The posting time for slot `index` of a profile: start + index × interval, inside working hours. */
export function slotTime(config: AutomationConfig, start: Date, index: number): Date {
  const interval = config.schedule.intervalMinutes * 60_000
  let at = new Date(start.getTime() + index * interval)
  const wh = config.schedule.workingHours
  if (!wh.enabled) return at
  const from = minutesOf(wh.start)
  const to = minutesOf(wh.end)
  for (let guard = 0; guard < 400; guard++) {
    const minute = at.getHours() * 60 + at.getMinutes()
    if (from < to ? minute >= from && minute < to : minute >= from || minute < to) return at
    // Move to the next window start, then keep the remaining offset of this slot.
    const next = new Date(at)
    next.setHours(Math.floor(from / 60), from % 60, 0, 0)
    if (next <= at) next.setDate(next.getDate() + 1)
    at = next
  }
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

  constructor(private readonly deps: Deps) {
    deps.queue.onSettled((task, settlement) => {
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
    const useDrafts = content.source !== 'generate'
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
    const plannedTargets: RunPlan['targets'] = chosen.map((profile) => {
      const account = this.deps.accounts.byProfile(profile.id)
      let reason: string | null = null
      if (profile.availability !== 'available') reason = 'Not reported by IX Browser'
      else if (!account) reason = targets.requireConfirmedIdentity || !targets.createMissingAccounts ? 'No account linked' : null
      else if (!account.enabled) reason = 'Account disabled for tasks'
      else if (targets.requireConfirmedIdentity && (account.identity !== 'confirmed' || !account.handle)) reason = 'Username not confirmed'
      return { profileId: profile.id, profileName: profile.name, accountId: account?.id ?? null, accountLabel: account?.label ?? null, eligible: reason === null, reason }
    })
    const unavailable = plannedTargets.filter((t) => t.reason === 'Not reported by IX Browser').length
    const eligible = plannedTargets.filter((t) => t.eligible)
    if (unavailable && config.failure.onProfileUnavailable === 'stop') block(`${unavailable} selected ${unavailable === 1 ? 'profile is' : 'profiles are'} unavailable.`)
    else if (unavailable) warn(`${unavailable} ${unavailable === 1 ? 'profile is' : 'profiles are'} unavailable and will be left out.`)
    const notLinked = plannedTargets.filter((t) => t.reason === 'No account linked').length
    const unconfirmed = plannedTargets.filter((t) => t.reason === 'Username not confirmed').length
    if (notLinked) warn(`${notLinked} ${notLinked === 1 ? 'profile has' : 'profiles have'} no account record and will be left out.`)
    if (unconfirmed) warn(`${unconfirmed} ${unconfirmed === 1 ? 'account has' : 'accounts have'} no confirmed X username, so the signed-in account can’t be checked — left out.`)
    if (!targets.requireConfirmedIdentity && publishing) warn('Posts may go out without checking which X account is signed in to the profile.')
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

    // Times.
    const start = schedule.when === 'now' ? this.now() : schedule.startAt ? new Date(schedule.startAt) : null
    if (schedule.when === 'schedule' && (!start || start.getTime() < this.now().getTime() - 60_000)) block('Choose a start time in the future.')
    if (schedule.endAt && start && new Date(schedule.endAt) <= start) block('The end time must be after the start time.')
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
    if (kinds.length && links.length === 0) block('Add the post links for reposting, commenting or liking.')
    if (badLinks.length) block(`${badLinks.length} engagement ${badLinks.length === 1 ? 'link is' : 'links are'} not a link to a post on X.`)
    if (actions.comment && !actions.commentText.trim()) block('Write the comment text for comment tasks.')
    const engagementTasks = kinds.length && eligible.length ? links.filter((l) => parsePostUrl(l)).length * kinds.length : 0
    if (engagementTasks) warn('Reposts, comments and likes are planned as tasks you complete in the profile — Axora Relay doesn’t do them automatically.')

    const summary: string[] = []
    if (publishing) summary.push(config.mode === 'full-auto' ? 'Publish automatically (Full Auto)' : 'Publish after your approval (Manual Approval)')
    else if (actions.publish || actions.saveDrafts) summary.push('Save as drafts only')
    if (fromDrafts) summary.push(`Post ${fromDrafts} of your drafts${content.source === 'mixed' && generations ? ', then generated posts' : ''}`)
    if (content.source !== 'drafts' && (content.source === 'generate' || generations > 0)) summary.push(content.generateText ? 'Generate text with AI' : 'Use your own text')
    if (content.generateImages) summary.push(useDrafts ? 'Generate and attach an image per post (drafts without one)' : 'Generate and attach an image per post')
    else if (content.existingAssetId) summary.push('Attach the selected library image')
    if (kinds.length) summary.push(`Plan ${kinds.join(', ')} tasks (done by you)`)

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
      images: content.generateImages ? generations + usableDrafts.slice(0, fromDrafts).filter((d) => !d.hasMedia).length : 0,
      engagementTasks,
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
    const start = config.schedule.when === 'now' ? this.now() : new Date(config.schedule.startAt!)
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
          // Round-robin over profiles so a cap of N posts spreads across profiles.
          let made = 0
          for (let slot = 0; slot < config.schedule.postsPerProfile && made < plan.posts; slot++) {
            for (const target of targets) {
              if (made >= plan.posts) break
              const at = slotTime(config, start, slot)
              if (end && at > end) continue
              const sourceDraftId = (config.targets.distribution === 'same' ? draftIds[slot] : draftIds[made]) ?? null
              if (config.content.source === 'drafts' && !sourceDraftId) continue
              add({ profileId: target.profileId, accountId: target.accountId, runAt: at.toISOString(), kind: 'post', sourceDraftId })
              made++
            }
          }
        }
      }
    })
    this.deps.log.info('Automation run started', { mode: config.mode, posts: plan.posts, profiles: targets.length, images: config.content.generateImages })

    // Engagement tasks: one account per post link (guardrails apply), done by the user.
    const engagementCount = this.planEngagement(runId, config, targets)

    if (this.deps.queue.paused && publishing && config.mode === 'full-auto') this.deps.queue.resume()
    this.deps.notifier.notify({ tone: 'info', event: 'systemNotices', title: 'Automation started', body: this.startBody(plan, engagementCount), to: '/automation' })
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
    this.deps.notifier.notify({ tone: 'info', event: 'systemNotices', title: 'Automation paused', body: 'Waiting posts stay in the queue until you resume.', to: '/automation' })
    return this.details(runId).run
  }

  resume(runId: Id): AutomationRun {
    const run = this.requireRun(runId)
    if (run.status !== 'paused') throw new ConflictError('This run is not paused.')
    this.failuresInRow.set(runId, 0)
    this.deps.db.run("UPDATE run_items SET status = 'pending', updated_at = :now WHERE run_id = :runId AND status = 'generating'", { runId, now: this.now().toISOString() })
    this.setStatus(runId, 'generating', null)
    this.deps.queue.resume()
    this.deps.notifier.notify({ tone: 'info', event: 'systemNotices', title: 'Automation resumed', to: '/automation' })
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
    this.finish(runId, 'stopped')
    this.deps.notifier.notify({ tone: 'info', event: 'systemNotices', title: 'Automation stopped', body: cancelled ? `${cancelled} waiting ${cancelled === 1 ? 'post was' : 'posts were'} cancelled and returned to your drafts.` : undefined, to: '/automation' })
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
      this.setStatus(id, 'paused', 'Paused because Axora Relay closed while posts were being prepared.')
    }
    if (runs.length) {
      this.deps.notifier.notify({ tone: 'info', event: 'systemNotices', title: 'Automation paused', body: 'Axora Relay closed while posts were being prepared. Resume the run to continue.', to: '/automation' })
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
              to: '/automation'
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
          to: '/automation'
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
  private usableDrafts(ids: Id[]): { id: Id; hasMedia: boolean }[] {
    if (!ids.length) return []
    const rows = this.deps.db.all<{ id: string; media: number }>(
      `SELECT d.id, (SELECT COUNT(*) FROM draft_attachments a WHERE a.draft_id = d.id) AS media FROM drafts d
       WHERE d.id IN (SELECT value FROM json_each(:ids)) AND d.status IN ('draft', 'ready')
         AND NOT EXISTS (SELECT 1 FROM scheduled_posts s WHERE s.draft_id = d.id AND s.status IN ('pending', 'queued', 'missed', 'needs-review'))`,
      { ids: JSON.stringify(ids) }
    )
    const byId = new Map(rows.map((r) => [r.id, r.media > 0]))
    return [...new Set(ids)].filter((id) => byId.has(id)).map((id) => ({ id, hasMedia: byId.get(id)! }))
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
    const due = item.run_at ? new Date(item.run_at) : this.now()
    const soon = due.getTime() <= this.now().getTime() + 60_000
    const entry = soon
      ? await this.deps.publishing.publishNow({ draftId: item.draft_id, accountId: item.account_id })
      : await this.deps.publishing.schedule({ draftId: item.draft_id, accountId: item.account_id, runAt: due.toISOString() })
    this.updateItem(item.id, { status: 'scheduled', schedule_id: entry.schedule.id, error: null })
    void config
  }

  private planEngagement(runId: Id, config: AutomationConfig, targets: { accountId: string | null }[]): number {
    const accounts = targets.map((t) => t.accountId).filter((a): a is string => Boolean(a))
    if (!accounts.length) return 0
    const links = config.actions.engagementLinks.map((l) => parsePostUrl(l)).filter((l): l is NonNullable<ReturnType<typeof parsePostUrl>> => Boolean(l))
    const kinds = ([config.actions.repost && 'repost', config.actions.comment && 'reply', config.actions.like && 'like'].filter(Boolean) as ('repost' | 'reply' | 'like')[])
    if (!links.length || !kinds.length) return 0
    let created = 0
    let turn = 0
    for (const parsed of links) {
      // The link is saved (or found) in Post Links first.
      const existing = this.deps.db.get<{ id: string }>('SELECT id FROM post_links WHERE url = :url OR post_id = :postId', { url: parsed.url, postId: parsed.postId })
      const linkId = existing?.id ?? randomUUID()
      if (!existing) {
        const now = this.now().toISOString()
        this.deps.db.run(
          `INSERT INTO post_links (id, url, post_id, handle, account_id, draft_id, task_id, source, preview, published_at, created_at, updated_at, notes, tags)
           VALUES (:id, :url, :postId, :handle, NULL, NULL, NULL, 'manual', '', NULL, :now, :now, '', '[]')`,
          { id: linkId, url: parsed.url, postId: parsed.postId, handle: parsed.handle, now }
        )
      }
      for (const kind of kinds) {
        // One account per post and kind — several of your accounts on one post is coordinated engagement.
        for (let i = 0; i < accounts.length; i++) {
          const accountId = accounts[(turn + i) % accounts.length]!
          const result = this.deps.engagement.create({ linkIds: [linkId], accountId, kind, dueAt: null, note: `From automation “${config.name}”`, replyText: kind === 'reply' ? config.actions.commentText : '' })
          if (result.created.length) {
            const task = result.created[0]!
            this.deps.db.run(
              `INSERT INTO run_items (id, run_id, position, kind, status, account_id, engagement_task_id, created_at, updated_at)
               VALUES (:id, :runId, (SELECT COALESCE(MAX(position), -1) + 1 FROM run_items WHERE run_id = :runId), 'engagement', 'saved', :accountId, :taskId, :now, :now)`,
              { id: randomUUID(), runId, accountId, taskId: task.id, now: this.now().toISOString() }
            )
            created++
            turn++
            break
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
    this.deps.notifier.notify({ tone: 'warning', event: 'taskFailures', title: 'Automation paused', body: message, to: '/automation' }, { key: `run-paused:${runId}`, quietMs: 60_000 })
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
        this.deps.notifier.notify({ tone: 'info', event: 'systemNotices', title: `${n} ${n === 1 ? 'post is' : 'posts are'} ready for your approval`, to: '/automation' })
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
    this.finish(runId, 'completed')
  }

  private finish(runId: Id, status: 'completed' | 'stopped' | 'failed'): void {
    const now = this.now().toISOString()
    this.deps.db.run('UPDATE automation_runs SET status = :status, finished_at = :now, updated_at = :now WHERE id = :id', { id: runId, status, now })
    if (status === 'completed') {
      const counts = this.countsOf(this.items(runId))
      this.deps.notifier.notify({
        tone: counts.failed || counts.needsReview ? 'warning' : 'success',
        event: 'systemNotices',
        title: 'Automation finished',
        body: [
          counts.published && `${counts.published} published`,
          counts.saved && `${counts.saved} saved`,
          counts.needsReview && `${counts.needsReview} need review`,
          counts.failed && `${counts.failed} failed`
        ]
          .filter(Boolean)
          .join(' · ') || undefined,
        to: '/automation'
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
           e.status AS engagement_status, e.kind AS engagement_kind, l2.url AS engagement_url
         FROM run_items i
         LEFT JOIN browser_profiles p ON p.id = i.profile_id
         LEFT JOIN accounts a ON a.id = i.account_id
         LEFT JOIN drafts d ON d.id = i.draft_id
         LEFT JOIN scheduled_posts s ON s.id = i.schedule_id
         LEFT JOIN engagement_tasks e ON e.id = i.engagement_task_id
         LEFT JOIN post_links l2 ON l2.id = e.link_id
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
        text: r.kind === 'engagement' ? `${r.engagement_kind === 'reply' ? 'Comment on' : r.engagement_kind === 'repost' ? 'Repost' : 'Like'} ${String(r.engagement_url ?? '')}` : ((r.draft_body as string) ?? null),
        imageAssetId: (r.asset_id as string) ?? null,
        image: r.image as RunItem['image'],
        scheduleId: (r.schedule_id as string) ?? null,
        scheduleStatus: (r.schedule_status as ScheduleStatus) ?? null,
        taskStatus: (r.task_status as TaskStatus) ?? null,
        postUrl: (r.post_url as string) ?? null,
        runAt: (r.run_at as string) ?? null,
        error: (r.error as string) ?? null
      }))
  }

  private countsOf(items: RunItem[]): RunCounts {
    const c: RunCounts = { total: 0, pending: 0, awaitingApproval: 0, scheduled: 0, published: 0, failed: 0, needsReview: 0, skipped: 0, saved: 0 }
    for (const i of items) {
      if (i.status === 'removed') continue
      c.total++
      if (i.status === 'pending' || i.status === 'generating') c.pending++
      else if (i.status === 'awaiting-approval') c.awaitingApproval++
      else if (i.status === 'saved') c.saved++
      else if (i.status === 'skipped') c.skipped++
      else if (i.status === 'failed') c.failed++
      else if (i.status === 'scheduled') {
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
      counts: withCounts ? this.countsOf(this.items(row.id!)) : { total: 0, pending: 0, awaitingApproval: 0, scheduled: 0, published: 0, failed: 0, needsReview: 0, skipped: 0, saved: 0 },
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

