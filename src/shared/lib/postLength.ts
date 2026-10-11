import { POST_MAX_WEIGHTED_LENGTH } from '@shared/config/app'

/**
 * Approximates X's weighted post length (twitter-text v3 rules, see
 * shared/config/postLimits.ts for sources): text is NFC-normalised, Latin and
 * common punctuation count 1, CJK and most other scripts count 2, emoji count
 * 2, and every URL counts as 23 regardless of its length. URL detection is
 * simpler than twitter-text's, so treat counts near the limit as estimates.
 */
const URL_PATTERN = /\bhttps?:\/\/[^\s]+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|ai|app|dev|me|ly)\b(?:\/[^\s]*)?/gi
const URL_WEIGHT = 23
const LIGHT_RANGES: [number, number][] = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247]
]
const EMOJI = /\p{Extended_Pictographic}/u
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })

function weightOf(grapheme: string): number {
  if (EMOJI.test(grapheme)) return 2
  const code = grapheme.codePointAt(0) ?? 0
  return LIGHT_RANGES.some(([min, max]) => code >= min && code <= max) ? 1 : 2
}

export interface PostLength {
  weighted: number
  remaining: number
  isOver: boolean
  /** 0..1 share of the limit used, capped at 1. */
  ratio: number
}

export function measurePost(text: string, limit = POST_MAX_WEIGHTED_LENGTH): PostLength {
  let weighted = 0
  const withoutUrls = text.normalize('NFC').replace(URL_PATTERN, () => {
    weighted += URL_WEIGHT
    return ''
  })
  for (const { segment } of segmenter.segment(withoutUrls)) weighted += weightOf(segment)
  return {
    weighted,
    remaining: limit - weighted,
    isOver: weighted > limit,
    ratio: Math.min(weighted / limit, 1)
  }
}
