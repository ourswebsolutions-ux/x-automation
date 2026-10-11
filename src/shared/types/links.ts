import type { Id, PostLink, Timestamp } from './domain'

/** A post link with its local notes, tags and engagement-task counts. */
export interface PostLinkView extends PostLink {
  notes: string
  tags: string[]
  updatedAt: Timestamp
  accountLabel: string | null
  openTasks: number
  doneTasks: number
}

export interface LinkUpdate {
  accountId: Id | null
  tags: string[]
  notes: string
}

export interface LinkAddInput {
  /** One or more post links, separated by new lines, spaces or commas. */
  text: string
  /** null = match each link to an account by the username in it. */
  accountId: Id | null
  tags: string[]
  notes: string
}

export interface LinkAddResult {
  added: PostLinkView[]
  /** Links already in the list (matched by post id). */
  duplicates: { url: string; existingId: Id }[]
  rejected: { line: number; text: string; reason: string }[]
}

export interface LinkImportResult extends LinkAddResult {
  cancelled: boolean
  fileName?: string
}

export interface LinkExportResult {
  cancelled: boolean
  fileName?: string
  count?: number
}

/**
 * Things a person plans to do with a post from one of their accounts.
 * X Auto never performs them on X — it can open the post in the
 * account's profile, and the person does the rest.
 */
export type EngagementKind = 'reply' | 'like' | 'repost' | 'quote' | 'bookmark' | 'follow-up' | 'other'
export type EngagementStatus = 'open' | 'done' | 'skipped'

export interface EngagementTask {
  id: Id
  linkId: Id
  accountId: Id | null
  kind: EngagementKind
  status: EngagementStatus
  dueAt: Timestamp | null
  note: string
  /** Text prepared for a reply or quote (copied by the user; never posted automatically). */
  replyText: string
  createdAt: Timestamp
  updatedAt: Timestamp
  completedAt: Timestamp | null
}

export interface EngagementTaskView extends EngagementTask {
  accountLabel: string | null
  accountHandle: string | null
  linkUrl: string
  linkPreview: string
  linkHandle: string | null
}

export interface EngagementInput {
  linkIds: Id[]
  accountId: Id | null
  kind: EngagementKind
  dueAt: Timestamp | null
  note: string
  replyText: string
}

export interface EngagementUpdate {
  accountId: Id | null
  kind: EngagementKind
  dueAt: Timestamp | null
  note: string
  replyText: string
}

export interface EngagementProblem {
  code: 'own-amplification' | 'coordinated' | 'duplicate' | 'daily-limit' | 'no-account' | 'account-missing' | 'link-missing' | 'account-disabled'
  message: string
  blocking: boolean
}

/** Result of checking one link for a planned task. */
export interface EngagementCheck {
  linkId: Id
  ok: boolean
  problems: EngagementProblem[]
}

export interface EngagementCreateResult {
  created: EngagementTaskView[]
  skipped: { linkId: Id; reason: string }[]
}

export interface EngagementQuery {
  status: EngagementStatus | 'all'
  accountId?: Id
  linkId?: Id
}

export interface EngagementSettings {
  /** Planned engagement tasks per account per day. 0 = no guideline. */
  dailyLimitPerAccount: number
}

export const DEFAULT_ENGAGEMENT_SETTINGS: EngagementSettings = { dailyLimitPerAccount: 25 }
export const ENGAGEMENT_LIMITS = { dailyLimitPerAccount: [0, 500] } as const

/** Kinds that amplify a post (counted for the coordination rules). */
export const AMPLIFYING_KINDS: readonly EngagementKind[] = ['like', 'repost', 'quote']
