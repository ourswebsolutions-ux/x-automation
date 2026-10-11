import type { AutomationConfig } from '@shared/types/automation'

/** A new automation: Full Auto, All Profiles, text on, images off, published now. */
export function defaultConfig(): AutomationConfig {
  return {
    name: 'My campaign',
    mode: 'full-auto',
    content: {
      // Campaigns post saved posts (created in Create Post).
      source: 'drafts',
      draftIds: [],
      prompt: '',
      topic: '',
      language: 'English',
      tone: 'professional',
      length: 'short',
      hashtags: [],
      suggestHashtags: false,
      instructions: '',
      generateText: true,
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
    targets: { scope: 'all', profileIds: [], distribution: 'unique', allowDuplicates: false, requireConfirmedIdentity: true, createMissingAccounts: false },
    actions: { publish: true, saveDrafts: false, repost: false, comment: false, like: false, engagementLinks: [], commentText: '' },
    schedule: { when: 'now', startAt: null, endAt: null, intervalMinutes: 30, postsPerProfile: 1, maxPostsPerRun: 20, workingHours: { enabled: false, start: '09:00', end: '18:00' }, days: [0, 1, 2, 3, 4, 5, 6] },
    failure: { generationRetries: 1, onTextFailure: 'skip', onImageFailure: 'pause', onProfileUnavailable: 'skip', stopAfterFailures: 3 }
  }
}

const KEY = 'axora.automation.draft'

/** The form is remembered on this device between visits (presets are the durable way to keep settings). */
export function loadDraftConfig(): AutomationConfig {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as AutomationConfig
      const base = defaultConfig()
      return { ...base, ...parsed, content: { ...base.content, ...parsed.content }, targets: { ...base.targets, ...parsed.targets }, actions: { ...base.actions, ...parsed.actions }, schedule: { ...base.schedule, ...parsed.schedule }, failure: { ...base.failure, ...parsed.failure } }
    }
  } catch {
    // Storage unavailable or old format: start fresh.
  }
  return defaultConfig()
}

export function saveDraftConfig(config: AutomationConfig): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(config))
  } catch {
    // Not critical.
  }
}
