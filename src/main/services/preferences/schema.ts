import { z } from 'zod'
import { LEGACY_ROUTES, ROUTE_IDS } from '@shared/config/navigation'
import { DEFAULT_PREFERENCES } from '@shared/config/app'
import { LOG_RETENTION_DAYS } from '@shared/types/preferences'

const channels = z.object({ inApp: z.boolean(), desktop: z.boolean() }).strict()
const providerId = z.uuid().nullable()

export const preferencesSchema = z.object({
  theme: z.enum(['dark', 'light', 'system']),
  sidebarCollapsed: z.boolean(),
  showDemoData: z.boolean(),
  reduceMotion: z.boolean(),
  // A start page that no longer exists (e.g. the removed logs page) falls back to the dashboard;
  // a merged page becomes the page that now holds it.
  startPage: z
    .enum(ROUTE_IDS)
    .catch('dashboard')
    .transform((id) => LEGACY_ROUTES[id] ?? id),
  startup: z.object({ launchAtLogin: z.boolean(), restoreWindow: z.boolean() }).strict(),
  confirmations: z.object({ deleteDraft: z.boolean(), discardChanges: z.boolean() }).strict(),
  retention: z.object({ logDays: z.literal([...LOG_RETENTION_DAYS]) }).strict(),
  notifications: z.object({ taskFailures: channels, scheduleReminders: channels, systemNotices: channels }).strict(),
  editor: z.object({ lengthProfile: z.enum(['standard', 'premium']) }).strict(),
  defaults: z
    .object({
      textProviderId: providerId,
      imageProviderId: providerId,
      imageSize: z.enum(['1024x1024', '1536x1024', '1024x1536'])
    })
    .strict()
})

export type PreferenceKey = keyof z.infer<typeof preferencesSchema>

/** Patch accepted over IPC: every key optional, nested objects partial, unknown keys rejected. */
export const preferencesPatchSchema = z
  .object({
    theme: preferencesSchema.shape.theme.optional(),
    sidebarCollapsed: z.boolean().optional(),
    showDemoData: z.boolean().optional(),
    reduceMotion: z.boolean().optional(),
    startPage: preferencesSchema.shape.startPage.optional(),
    startup: preferencesSchema.shape.startup.partial().optional(),
    confirmations: preferencesSchema.shape.confirmations.partial().optional(),
    retention: preferencesSchema.shape.retention.partial().optional(),
    notifications: z
      .object({
        taskFailures: channels.partial().optional(),
        scheduleReminders: channels.partial().optional(),
        systemNotices: channels.partial().optional()
      })
      .strict()
      .optional(),
    editor: preferencesSchema.shape.editor.partial().optional(),
    defaults: preferencesSchema.shape.defaults.partial().optional()
  })
  .strict()

export const DEFAULTS = preferencesSchema.parse(DEFAULT_PREFERENCES)
