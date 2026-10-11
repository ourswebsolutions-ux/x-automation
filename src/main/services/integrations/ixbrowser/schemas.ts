import { z } from 'zod'
import type { IxProfileRecord } from './types'

/** Runtime validation of IX Browser responses — never trust the wire. */

export const envelopeSchema = z.object({
  error: z.object({ code: z.number().int(), message: z.string().nullish() }),
  data: z.unknown().optional()
})

export const paginatedSchema = z.object({
  total: z.number().int().nonnegative(),
  data: z.array(z.unknown()).nullable()
})

const profileSchema = z
  .object({
    profile_id: z.number().int().positive(),
    name: z.string().max(500).nullish(),
    site_url: z.string().max(2000).nullish()
  })
  .passthrough()

/** Opened-list items: documented only as a list — accept ids or objects carrying profile_id. */
const openedItemSchema = z.union([
  z.number().int().positive(),
  z.object({ profile_id: z.number().int().positive() }).passthrough()
])
export const openedListSchema = z.array(openedItemSchema).nullable()

export const openResultSchema = z
  .object({ debugging_address: z.string().max(200).nullish() })
  .passthrough()
  .nullable()

/**
 * Fields that may carry credentials or session state. Anything matching is
 * dropped before storage — profile records only keep descriptive metadata.
 */
const SENSITIVE_FIELD = /pass|pwd|secret|token|cookie|session|auth|2fa|tfa|otp|key|credential|proxy_user|username|email|phone/i
const KNOWN = new Set(['profile_id', 'name', 'site_url'])

export function toProfileRecord(raw: unknown): IxProfileRecord | null {
  const parsed = profileSchema.safeParse(raw)
  if (!parsed.success) return null
  const extra: IxProfileRecord['extra'] = {}
  for (const [key, value] of Object.entries(parsed.data)) {
    if (KNOWN.has(key) || SENSITIVE_FIELD.test(key) || key.length > 40) continue
    if (typeof value === 'string' && value.length <= 300) extra[key] = value
    else if (typeof value === 'number' && Number.isFinite(value)) extra[key] = value
    else if (typeof value === 'boolean') extra[key] = value
    if (Object.keys(extra).length >= 30) break
  }
  return {
    profileId: parsed.data.profile_id,
    name: parsed.data.name?.trim() || `Profile ${parsed.data.profile_id}`,
    siteUrl: parsed.data.site_url?.trim() || null,
    extra
  }
}

export function openedIds(raw: unknown): number[] | null {
  const parsed = openedListSchema.safeParse(raw === undefined || raw === true ? [] : raw)
  if (!parsed.success) return null
  return (parsed.data ?? []).map((item) => (typeof item === 'number' ? item : item.profile_id))
}
