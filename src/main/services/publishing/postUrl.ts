/** A post link on X, normalised to https://x.com/<handle>/status/<id>. */
export interface ParsedPostUrl {
  url: string
  /** Null for x.com/i/status/<id> links, which do not name the account. */
  handle: string | null
  postId: string
}

const HOSTS = new Set(['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'])
const PATH = /^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,25})(?:\/.*)?$/
const ANONYMOUS = /^\/i\/(?:web\/)?status\/(\d{1,25})(?:\/.*)?$/

/**
 * Accepts links to single posts on x.com or twitter.com (with or without
 * www/mobile, query strings or trailing /photo/1 and the like). Anything
 * else — other sites, profiles, search pages — returns null.
 */
export function parsePostUrl(input: string): ParsedPostUrl | null {
  const raw = input.trim()
  if (!raw || raw.length > 500) return null
  let url: URL
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.username || url.password || url.port) return null
  if (!HOSTS.has(url.hostname.toLowerCase())) return null
  const anonymous = ANONYMOUS.exec(url.pathname)
  if (anonymous) return { url: `https://x.com/i/status/${anonymous[1]}`, handle: null, postId: anonymous[1]! }
  const match = PATH.exec(url.pathname)
  if (!match || match[1]!.toLowerCase() === 'i') return null
  return { url: `https://x.com/${match[1]}/status/${match[2]}`, handle: match[1]!, postId: match[2]! }
}
