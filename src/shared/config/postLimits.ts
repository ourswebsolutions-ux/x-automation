/**
 * X post length rules, verified 2026-10-10 against:
 *  - X developer docs, "Counting characters"
 *    https://docs.x.com/resources/fundamentals/counting-characters
 *    280 weighted characters; Latin/punctuation weigh 1, CJK, emoji and other
 *    scripts weigh 2; any URL counts as 23; text is NFC-normalised first.
 *  - twitter-text config v3 (maxWeightedTweetLength 280, transformedURLLength 23,
 *    weight-1 ranges 0–4351, 8192–8205, 8208–8223, 8242–8247)
 *    https://github.com/twitter/twitter-text/blob/master/config/v3.json
 *  - X Help Center, "About X Premium": subscribers can write longer posts of up
 *    to 25,000 characters. https://help.x.com/using-x/x-premium
 *
 * X Auto cannot see whether an account has X Premium, so the profile is
 * the user's choice and the editor says so.
 */
export type LengthProfileId = 'standard' | 'premium'

export interface LengthProfile {
  id: LengthProfileId
  label: string
  maxWeighted: number
  description: string
  source: string
}

export const LENGTH_PROFILES: Record<LengthProfileId, LengthProfile> = {
  standard: {
    id: 'standard',
    label: 'Standard · 280',
    maxWeighted: 280,
    description: 'The limit for every X account. Emoji and CJK characters count twice; links count as 23.',
    source: 'https://docs.x.com/resources/fundamentals/counting-characters'
  },
  premium: {
    id: 'premium',
    label: 'Longer posts · 25,000',
    maxWeighted: 25_000,
    description: 'Only accounts with an X Premium subscription can publish posts longer than 280 characters.',
    source: 'https://help.x.com/using-x/x-premium'
  }
}

export const LENGTH_PROFILE_LIST = Object.values(LENGTH_PROFILES)

/** Hashtags are stored without "#": letters (any script), digits and underscores. */
export const HASHTAG_PATTERN = /^[\p{L}\p{N}_]{1,100}$/u
export const MAX_HASHTAGS = 30

/** Normalises "#Tag", " tag " → "Tag"; null when it is not a valid hashtag. */
export function normalizeHashtag(value: string): string | null {
  const tag = value.trim().replace(/^#+/, '')
  return HASHTAG_PATTERN.test(tag) && !/^\d+$/.test(tag) ? tag : null
}

/**
 * The text that would be posted: the body, then any hashtags not already in
 * it on their own line. Used for counting, preview and AI prompts.
 */
export function composePost(body: string, hashtags: string[]): string {
  const present = new Set((body.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((t) => t.slice(1).toLowerCase()))
  const extra = hashtags.filter((t) => !present.has(t.toLowerCase()))
  if (!extra.length) return body
  const tags = extra.map((t) => `#${t}`).join(' ')
  return body.trim() ? `${body.trimEnd()}\n\n${tags}` : tags
}
