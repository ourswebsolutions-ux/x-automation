import type { Preferences } from '../types/preferences'
import { CURRENT_PHASE } from './roadmap'

export const APP_NAME = 'X Auto'
export const APP_PHASE = CURRENT_PHASE

export const DEFAULT_IXBROWSER_ENDPOINT = 'http://127.0.0.1:53200'

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'dark',
  sidebarCollapsed: false,
  showDemoData: true,
  reduceMotion: false,
  startPage: 'dashboard',
  startup: {
    launchAtLogin: false,
    restoreWindow: true
  },
  confirmations: {
    deleteDraft: true,
    discardChanges: true
  },
  retention: {
    logDays: 30
  },
  notifications: {
    taskFailures: { inApp: true, desktop: false },
    scheduleReminders: { inApp: true, desktop: false },
    systemNotices: { inApp: true, desktop: false }
  },
  editor: {
    lengthProfile: 'standard'
  },
  defaults: {
    textProviderId: null,
    imageProviderId: null,
    imageSize: '1024x1024'
  }
}

/** X counts posts with a weighted length; 280 is the standard account limit. */
export const POST_MAX_WEIGHTED_LENGTH = 280
