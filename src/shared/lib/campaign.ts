import type { AutomationConfig } from '@shared/types/automation'

/**
 * The Campaigns form's choices and the automation config they become (shared so tests check the exact
 * config the form sends).
 */

export type CampaignAction = 'post' | 'repost' | 'comment'

/** The choices of a campaign; everything else is fixed (see toConfig). Profiles are never chosen: every eligible synchronized profile takes part. */
export interface CampaignChoices {
  name: string
  action: CampaignAction
  draftIds: string[]
  /** Repost / comment targets (post links). */
  repostLinks: string[]
  /** Your comment (comment action) — you approve and post it yourself from the task. */
  commentText: string
  when: 'now' | 'schedule'
  startAt: string | null
  /** This campaign's random account order (a new one for each new campaign; the preview and Start share it). */
  seed: number
}

/** A new random seed for the next campaign's account order. */
export const newSeed = () => Math.floor(Math.random() * 4_294_967_296)

export const defaultChoices = (): CampaignChoices => ({
  name: 'My campaign',
  action: 'post',
  draftIds: [],
  repostLinks: [],
  commentText: '',
  when: 'now',
  startAt: null,
  seed: newSeed()
})

/**
 * The automation config for these choices, on the existing campaign engine. Every selected post goes
 * out once, from one randomly chosen eligible synchronized profile (the main process decides which
 * profiles are eligible; the campaign's seed fixes the random order, so Start = the preview). Fixed: posted
 * automatically, the signed-in account checked wherever its X username is confirmed, one post per
 * slot (queue spacing applies), no end date / posting days / hours. A saved post's comment goes out
 * as a reply from the same account after the post. Reposts and comments on Post Links are tasks you
 * complete in the profile — one of your accounts per post (several of your accounts on one post is
 * coordinated engagement); the comment is your own text.
 */
export function toConfig(c: CampaignChoices): AutomationConfig {
  const posting = c.action === 'post'
  const count = Math.min(Math.max(c.draftIds.length, 1), 50)
  return {
    name: c.name.trim() || 'Campaign',
    mode: 'full-auto',
    content: {
      source: 'drafts',
      draftIds: posting ? c.draftIds : [],
      prompt: '',
      topic: '',
      language: 'English',
      tone: 'professional',
      length: 'short',
      hashtags: [],
      suggestHashtags: false,
      instructions: '',
      generateText: false,
      textProviderId: null,
      textModel: null,
      fixedText: '',
      generateImages: false,
      imageProviderId: null,
      imageModel: null,
      imageStyle: 'illustration',
      imageSize: '1024x1024',
      existingAssetId: null
    },
    // One randomly chosen eligible account per selected post (accounts in this campaign's random order).
    targets: { scope: 'all', profileIds: [], distribution: 'unique', allowDuplicates: false, requireConfirmedIdentity: false, createMissingAccounts: true, shuffleSeed: c.seed },
    actions: {
      publish: posting,
      saveDrafts: false,
      repost: c.action === 'repost',
      comment: c.action === 'comment',
      like: false,
      engagementLinks: posting ? [] : c.repostLinks,
      commentText: c.action === 'comment' ? c.commentText : ''
    },
    schedule: { when: c.when, startAt: c.when === 'schedule' ? c.startAt : null, endAt: null, intervalMinutes: 0, postsPerProfile: count, maxPostsPerRun: 500, workingHours: { enabled: false, start: '09:00', end: '18:00' }, days: [0, 1, 2, 3, 4, 5, 6] },
    // A failing account never stops the others: its own posts fail (or are held when it is signed out); the run keeps going.
    failure: { generationRetries: 0, onTextFailure: 'skip', onImageFailure: 'skip', onProfileUnavailable: 'skip', stopAfterFailures: 0 }
  }
}

/** Choices from an older saved setup (e.g. a dashboard quick-start link): keep what still applies. */
export function choicesFrom(config: AutomationConfig): CampaignChoices {
  const base = defaultChoices()
  return {
    ...base,
    name: config.name,
    draftIds: config.content.source === 'drafts' ? config.content.draftIds : [],
    when: config.schedule.when,
    startAt: config.schedule.startAt
  }
}
