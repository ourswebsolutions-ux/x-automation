import { z } from 'zod'
import { LANGUAGES, TONES } from '@shared/types/generator'
import { IMAGE_STYLES } from '@shared/types/images'
import type { AutomationConfig } from '@shared/types/automation'

const id = z.uuid()
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM')
const iso = z.iso.datetime({ offset: true })

/** The one schema for automation configs: IPC input and stored presets are both checked with it. */
export const automationConfigSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    mode: z.enum(['full-auto', 'manual-approval']),
    content: z
      .object({
        // Older presets have neither field: they used generated (or fixed) text.
        source: z.enum(['generate', 'drafts', 'mixed']).default('generate'),
        draftIds: z.array(id).max(500).default([]),
        prompt: z.string().max(4000),
        topic: z.string().max(200),
        language: z.enum(LANGUAGES),
        tone: z.enum(TONES),
        length: z.enum(['short', 'medium', 'long']),
        hashtags: z.array(z.string().max(100)).max(30),
        suggestHashtags: z.boolean(),
        instructions: z.string().max(2000),
        generateText: z.boolean(),
        textProviderId: id.nullable(),
        textModel: z.string().max(120).nullable(),
        fixedText: z.string().max(25_000),
        generateImages: z.boolean(),
        imageProviderId: id.nullable(),
        imageModel: z.string().max(120).nullable(),
        imageStyle: z.enum(IMAGE_STYLES),
        imageSize: z.string().regex(/^(\d{3,4}x\d{3,4}|auto)$/),
        existingAssetId: id.nullable()
      })
      .strict(),
    targets: z
      .object({
        scope: z.enum(['all', 'selected']),
        profileIds: z.array(id).max(5000),
        distribution: z.enum(['unique', 'same', 'drafts']),
        allowDuplicates: z.boolean(),
        requireConfirmedIdentity: z.boolean(),
        createMissingAccounts: z.boolean(),
        shuffleSeed: z.number().int().min(0).max(4_294_967_295).optional()
      })
      .strict(),
    actions: z
      .object({
        publish: z.boolean(),
        saveDrafts: z.boolean(),
        repost: z.boolean(),
        comment: z.boolean(),
        like: z.boolean(),
        engagementLinks: z.array(z.string().max(500)).max(200),
        commentText: z.string().max(4000)
      })
      .strict(),
    schedule: z
      .object({
        when: z.enum(['now', 'schedule']),
        startAt: iso.nullable(),
        endAt: iso.nullable(),
        intervalMinutes: z.number().int().min(0).max(1440),
        postsPerProfile: z.number().int().min(1).max(50),
        maxPostsPerRun: z.number().int().min(1).max(500),
        workingHours: z.object({ enabled: z.boolean(), start: time, end: time }).strict(),
        // Older configs have no posting days: every day.
        days: z.array(z.number().int().min(0).max(6)).max(7).default([0, 1, 2, 3, 4, 5, 6])
      })
      .strict(),
    failure: z
      .object({
        generationRetries: z.number().int().min(0).max(3),
        onTextFailure: z.enum(['skip', 'pause']),
        onImageFailure: z.enum(['pause', 'skip', 'without-image']),
        onProfileUnavailable: z.enum(['skip', 'stop']),
        stopAfterFailures: z.number().int().min(0).max(100)
      })
      .strict()
  })
  .strict()

export function parseConfig(value: unknown): AutomationConfig {
  return automationConfigSchema.parse(value) as AutomationConfig
}
