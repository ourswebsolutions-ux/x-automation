/**
 * Core domain model shared by the main process and the renderer.
 * These are plain data shapes — persistence, validation and behaviour live
 * in main-process services.
 */

export type Id = string
/** ISO-8601 timestamp string. */
export type Timestamp = string

/** X account records live in ./accounts. */

export type DraftStatus = 'draft' | 'ready' | 'scheduled' | 'published' | 'failed'
export type DraftOrigin = 'manual' | 'ai'

/** An image attached to a draft, in display order. Files stay in the asset library. */
export interface MediaAttachment {
  /** The library asset id. */
  id: Id
  kind: 'image'
  /** URL served by the main process from the asset folder (never a file path). */
  url: string
  altText: string
  mimeType: string
  width: number
  height: number
  sizeBytes: number
  animated: boolean
  /** False when the file has gone missing from disk. */
  available: boolean
}

/**
 * A comment saved with a post. After X confirms the post, the same account posts the comment as a
 * reply to that post — never to anyone else's post, and never from another account.
 */
export interface PostComment {
  enabled: boolean
  text: string
}

export interface AttachmentInput {
  assetId: Id
  altText: string
}

export interface Draft {
  id: Id
  body: string
  /** Hashtags without "#", appended to the body when posted (see composePost). */
  hashtags: string[]
  accountId: Id | null
  status: DraftStatus
  /** 'ai' = generated or AI-assisted at some point; 'manual' = written by hand. */
  origin: DraftOrigin
  /** The generation this draft came from, when it was created from AI output. */
  sourceGenerationId: Id | null
  /** Image attachments, in order (draft_attachments → image_assets). */
  media: MediaAttachment[]
  /** Posted as a reply to this post by the same account, once the post is confirmed. */
  comment: PostComment
  createdAt: Timestamp
  updatedAt: Timestamp
}

/** Fields the renderer may submit when creating or editing a draft. */
export interface DraftInput {
  id?: Id
  body: string
  hashtags?: string[]
  /** Only 'draft' and 'ready' can be set by hand; later states belong to scheduling. */
  status?: Extract<DraftStatus, 'draft' | 'ready'>
  accountId: Id | null
  /** Set when the text came from (or was changed by) AI. A draft never goes back to 'manual'. */
  aiAssisted?: boolean
  sourceGenerationId?: Id | null
  /** Full ordered list of attachments; omitted = keep the current ones. */
  attachments?: AttachmentInput[]
  /** Omitted = keep the current comment. */
  comment?: PostComment
}

/**
 * pending: waiting for its time · queued: handed to the task queue ·
 * missed: the time passed while the app was closed — waiting for the user ·
 * needs-review: publishing may or may not have happened — the user must check.
 */
export type ScheduleStatus = 'pending' | 'queued' | 'completed' | 'cancelled' | 'failed' | 'missed' | 'needs-review'

export interface ScheduledPost {
  id: Id
  draftId: Id
  accountId: Id
  runAt: Timestamp
  status: ScheduleStatus
  remindedAt: Timestamp | null
  createdAt: Timestamp
  updatedAt: Timestamp
}

export type TaskKind = 'publish' | 'reply' | 'generate-text' | 'generate-image' | 'sync-profiles'
/** needs-review: the task may already have taken effect; it is never retried automatically. */
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'needs-review'

/** What a finished publish task produced. */
export interface PublishResult {
  url: string | null
  postId: string | null
  /** Handle seen in the post link (may differ from the account record). */
  handle: string | null
  /** How the outcome was established. */
  /** post-link: X's confirmation · profile-check: found on the account's profile after an unconfirmed submit · user: you confirmed it. */
  verifiedBy: 'post-link' | 'profile-check' | 'user'
}

export interface Task {
  id: Id
  kind: TaskKind
  status: TaskStatus
  accountId: Id | null
  draftId: Id | null
  scheduleId: Id | null
  label: string
  attempts: number
  maxAttempts: number
  /** The task is not started before this time (backoff, spacing). */
  runAfter: Timestamp
  createdAt: Timestamp
  startedAt: Timestamp | null
  finishedAt: Timestamp | null
  /** Plain-language outcome for the user; never raw exception text. */
  error: string | null
  errorCode: string | null
  result: PublishResult | null
  /** Put on hold by the user: stays queued but is not started until released. */
  held: boolean
}

export type PostLinkSource = 'published' | 'manual' | 'imported'

export interface PostLink {
  id: Id
  url: string
  /** X post id from the link (digits). */
  postId: string | null
  /** Handle from the link, without "@". */
  handle: string | null
  accountId: Id | null
  draftId: Id | null
  taskId: Id | null
  source: PostLinkSource
  /** A short preview of the post text, when X Auto published it. */
  preview: string
  publishedAt: Timestamp | null
  createdAt: Timestamp
}

export type ActivityLevel = 'info' | 'success' | 'warning' | 'error'

export interface ActivityEvent {
  id: Id
  level: ActivityLevel
  message: string
  /** Optional subject, e.g. an account handle. */
  subject: string | null
  at: Timestamp
}

export interface WorkspaceSummary {
  profiles: number
  drafts: number
  scheduled: number
  pendingTasks: number
  recentActivity: ActivityEvent[]
  recentTasks: Task[]
}
