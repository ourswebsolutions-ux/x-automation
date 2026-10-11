import type { Id, ScheduleStatus, TaskStatus, Timestamp } from './domain'
import type { PostLength, Tone } from './generator'
import type { ImageStyle } from './images'

/** Full Auto publishes without per-post confirmation; Manual Approval waits for the user. */
export type AutomationMode = 'full-auto' | 'manual-approval'

/**
 * Where a run's posts come from: generate = AI (or your fixed text) · drafts = only the drafts you
 * picked, unchanged · mixed = your drafts first, then generated posts for the remaining slots.
 */
export type ContentSource = 'generate' | 'drafts' | 'mixed'

export interface ContentSettings {
  source: ContentSource
  /** Your own drafts (status draft/ready), used in this order when source is drafts or mixed. */
  draftIds: Id[]
  /** The main instructions, e.g. "Professional technology posts in English". */
  prompt: string
  topic: string
  language: string
  tone: Tone
  length: PostLength
  /** Hashtags to include (without "#"). */
  hashtags: string[]
  suggestHashtags: boolean
  instructions: string
  generateText: boolean
  textProviderId: Id | null
  textModel: string | null
  /** Used when text generation is off (the same text for every post). */
  fixedText: string
  generateImages: boolean
  imageProviderId: Id | null
  imageModel: string | null
  imageStyle: ImageStyle
  imageSize: string
  /** A library image attached to every post when image generation is off. */
  existingAssetId: Id | null
}

export interface TargetSettings {
  /** all = every synced profile that is available and eligible; selected = only profileIds. */
  scope: 'all' | 'selected'
  profileIds: Id[]
  /** unique: different posts per profile · same: the same posts on every profile (needs allowDuplicates) · drafts: save only. */
  distribution: 'unique' | 'same' | 'drafts'
  allowDuplicates: boolean
  /** Publishing needs the X username to be confirmed, so the signed-in account can be checked first. */
  requireConfirmedIdentity: boolean
  /** Profiles without an account record get one (username unknown) — only with requireConfirmedIdentity off. */
  createMissingAccounts: boolean
}

export interface ActionSettings {
  publish: boolean
  saveDrafts: boolean
  /** Engagement actions: planned as tasks you complete in the profile (never performed automatically). */
  repost: boolean
  comment: boolean
  like: boolean
  /** Posts the engagement actions apply to (x.com/twitter.com links). */
  engagementLinks: string[]
  /** Your comment text for comment tasks (copied by you; never posted automatically). */
  commentText: string
}

export interface ScheduleSettings {
  when: 'now' | 'schedule'
  startAt: Timestamp | null
  /** No post is scheduled after this time. */
  endAt: Timestamp | null
  /** Minutes between two posts of the same profile. */
  intervalMinutes: number
  postsPerProfile: number
  maxPostsPerRun: number
  workingHours: { enabled: boolean; start: string; end: string }
  /** Posting days of the week (0 = Sunday … 6 = Saturday). Posts are only placed on these days. */
  days: number[]
}

export interface FailurePolicy {
  /** Extra attempts when text or image generation fails (0–3). */
  generationRetries: number
  /** After retries: skip that post, or pause the run. */
  onTextFailure: 'skip' | 'pause'
  /** After retries: pause, skip the post, or publish it without an image (only if chosen here). */
  onImageFailure: 'pause' | 'skip' | 'without-image'
  /** A target profile is unavailable at start: leave it out, or don't start. */
  onProfileUnavailable: 'skip' | 'stop'
  /** Pause the run after this many failed posts in a row (0 = never). */
  stopAfterFailures: number
}

export interface AutomationConfig {
  name: string
  mode: AutomationMode
  content: ContentSettings
  targets: TargetSettings
  actions: ActionSettings
  schedule: ScheduleSettings
  failure: FailurePolicy
}

export interface PromptPreset {
  id: Id
  name: string
  config: AutomationConfig
  createdAt: Timestamp
  updatedAt: Timestamp
}

/** What Start would do — shown before the single confirmation. */
export interface RunPlan {
  ok: boolean
  problems: { message: string; blocking: boolean }[]
  profiles: { selected: number; available: number; unavailable: number; eligible: number; withoutAccount: number; unconfirmed: number }
  targets: { profileId: Id; profileName: string; accountId: Id | null; accountLabel: string | null; eligible: boolean; reason: string | null }[]
  posts: number
  /** Unique texts to generate. */
  generations: number
  /** Posts that come from your own drafts. */
  fromDrafts: number
  images: number
  engagementTasks: number
  firstRunAt: Timestamp | null
  lastRunAt: Timestamp | null
  actions: string[]
}

export type RunStatus = 'generating' | 'awaiting-approval' | 'publishing' | 'paused' | 'completed' | 'stopped' | 'failed'
export type RunItemStatus = 'pending' | 'generating' | 'awaiting-approval' | 'scheduled' | 'saved' | 'skipped' | 'failed' | 'removed'

export interface RunItem {
  id: Id
  runId: Id
  position: number
  kind: 'post' | 'engagement'
  status: RunItemStatus
  profileId: Id | null
  profileName: string | null
  accountId: Id | null
  accountLabel: string | null
  draftId: Id | null
  /** The post comes from one of your own drafts (not generated). */
  fromDraft: boolean
  /** Comment / repost tasks: whether you have done it yet (null for posts). */
  engagementStatus: 'open' | 'done' | 'skipped' | null
  /** Post text preview (from the draft). */
  text: string | null
  /** Library asset id of the attached image, if any. */
  imageAssetId: Id | null
  image: 'none' | 'attached' | 'failed' | 'skipped'
  scheduleId: Id | null
  scheduleStatus: ScheduleStatus | null
  taskStatus: TaskStatus | null
  postUrl: string | null
  runAt: Timestamp | null
  error: string | null
}

export interface RunCounts {
  total: number
  pending: number
  awaitingApproval: number
  scheduled: number
  published: number
  failed: number
  needsReview: number
  skipped: number
  saved: number
}

export interface AutomationRun {
  id: Id
  name: string
  mode: AutomationMode
  status: RunStatus
  config: AutomationConfig
  message: string | null
  /** The recurring schedule that started this run (null = started by hand). */
  scheduleId: Id | null
  counts: RunCounts
  createdAt: Timestamp
  updatedAt: Timestamp
  finishedAt: Timestamp | null
}

export interface RunDetails {
  run: AutomationRun
  items: RunItem[]
}

/** A recurring automation: one run per chosen day, inside a daily window, between two dates. */
export interface AutomationSchedule {
  id: Id
  name: string
  status: 'active' | 'paused' | 'ended'
  /** Snapshot of the automation settings (taken when the schedule was saved). */
  config: AutomationConfig
  presetId: Id | null
  /** Local dates, YYYY-MM-DD. */
  startDate: string
  endDate: string | null
  /** Days of the week, 0 = Sunday … 6 = Saturday. */
  days: number[]
  /** Daily window, local HH:MM (start before end). Posts are spread inside it. */
  windowStart: string
  windowEnd: string
  lastRunDate: string | null
  lastRunId: Id | null
  /** Plain-language note about the last day (e.g. why it didn't run). */
  lastMessage: string | null
  /** Start of the next window this schedule will run in (null = none left / paused). */
  nextRunAt: Timestamp | null
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface AutomationScheduleInput {
  id?: Id
  name: string
  config: AutomationConfig
  presetId: Id | null
  startDate: string
  endDate: string | null
  days: number[]
  windowStart: string
  windowEnd: string
}
