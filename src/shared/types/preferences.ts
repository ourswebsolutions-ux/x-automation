import type { RouteId } from '../config/navigation'

import type { LengthProfileId } from '../config/postLimits'

export type ThemePreference = 'dark' | 'light' | 'system'
export type NotificationEvent = 'taskFailures' | 'scheduleReminders' | 'systemNotices'
export type ImageSize = '1024x1024' | '1536x1024' | '1024x1536'
export const LOG_RETENTION_DAYS = [7, 30, 90, 365] as const
export type LogRetentionDays = (typeof LOG_RETENTION_DAYS)[number]

export interface NotificationChannelPrefs {
  inApp: boolean
  desktop: boolean
}

/**
 * Non-secret user preferences, persisted in SQLite (app_settings and
 * notification_preferences). API keys never live here — see CredentialVault.
 */
export interface Preferences {
  theme: ThemePreference
  sidebarCollapsed: boolean
  showDemoData: boolean
  reduceMotion: boolean
  startPage: RouteId
  startup: {
    launchAtLogin: boolean
    restoreWindow: boolean
  }
  confirmations: {
    deleteDraft: boolean
    discardChanges: boolean
  }
  retention: {
    logDays: LogRetentionDays
  }
  notifications: Record<NotificationEvent, NotificationChannelPrefs>
  editor: {
    /** Which X length limit drafts are checked against. */
    lengthProfile: LengthProfileId
  }
  defaults: {
    textProviderId: string | null
    imageProviderId: string | null
    imageSize: ImageSize
  }
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K]
}

export type PreferencesPatch = DeepPartial<Preferences>
