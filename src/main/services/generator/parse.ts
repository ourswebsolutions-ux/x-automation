import { normalizeHashtag } from '@shared/config/postLimits'

/**
 * Reads the JSON array the prompt asked for. Models sometimes wrap JSON in
 * code fences or add a sentence around it, so the outermost object is
 * extracted first. Returns null when nothing usable is found — the caller
 * reports that honestly rather than guessing.
 */
export function parseResults(text: string, key: 'variations' | 'hashtags', expected: number): string[] | null {
  const cleaned = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
  const candidates = [cleaned]
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(cleaned.slice(start, end + 1))
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      const value = Array.isArray(parsed) ? parsed : (parsed as Record<string, unknown> | null)?.[key]
      if (!Array.isArray(value)) continue
      const strings = value.filter((v): v is string => typeof v === 'string')
      const out = key === 'hashtags' ? hashtagsFrom(strings) : postsFrom(strings)
      return out.length ? out.slice(0, Math.max(expected, 1) + (key === 'hashtags' ? 2 : 0)) : null
    } catch {
      // try the next candidate
    }
  }
  // A single plain-text answer to a single-result request is still the result.
  if (key === 'variations' && expected === 1 && cleaned && !cleaned.startsWith('{') && !cleaned.startsWith('[')) return postsFrom([cleaned])
  return null
}

function postsFrom(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const post = value
      .trim()
      .replace(/^["“”']+|["“”']+$/g, '')
      .trim()
    if (!post || seen.has(post)) continue
    seen.add(post)
    out.push(post)
  }
  return out
}

function hashtagsFrom(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const tag = normalizeHashtag(value.replace(/\s+/g, ''))
    if (!tag || seen.has(tag.toLowerCase())) continue
    seen.add(tag.toLowerCase())
    out.push(tag)
  }
  return out
}
