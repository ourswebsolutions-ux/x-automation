import type { ProviderKind } from '../types/providers'

export interface ProviderKindMeta {
  kind: ProviderKind
  label: string
  description: string
  defaultName: string
  defaultEndpoint: string
  requiresKey: boolean
  requiresModel: boolean
  /** Only loopback endpoints are accepted (local desktop APIs). */
  loopbackOnly: boolean
  /** Refuse private-network, link-local and internal hosts (loopback stays allowed for local servers). */
  blockPrivateNetwork: boolean
  modelSuggestions: string[]
  /** Phase in which a real connection test ships. */
  testPhase: number
}

export const PROVIDER_KINDS: Record<ProviderKind, ProviderKindMeta> = {
  ixbrowser: {
    kind: 'ixbrowser',
    label: 'IX Browser local API',
    description: 'Browser profile management through IX Browser on this computer.',
    defaultName: 'IX Browser',
    defaultEndpoint: 'http://127.0.0.1:53200',
    requiresKey: false,
    requiresModel: false,
    loopbackOnly: true,
    blockPrivateNetwork: false,
    modelSuggestions: [],
    testPhase: 3
  },
  'openai-compatible': {
    kind: 'openai-compatible',
    label: 'AI text provider',
    description: 'OpenAI, or any service with an OpenAI-compatible API, for generating and rewriting text.',
    defaultName: 'OpenAI',
    defaultEndpoint: 'https://api.openai.com/v1',
    requiresKey: true,
    requiresModel: true,
    loopbackOnly: false,
    blockPrivateNetwork: true,
    // Models come from the provider's own list — see shared/config/aiAdapters.ts.
    modelSuggestions: [],
    testPhase: 5
  },
  image: {
    kind: 'image',
    label: 'Image generation',
    description: 'Services that create images from a prompt for post attachments.',
    defaultName: 'OpenAI Images',
    defaultEndpoint: 'https://api.openai.com/v1',
    requiresKey: true,
    requiresModel: true,
    loopbackOnly: false,
    blockPrivateNetwork: true,
    modelSuggestions: ['gpt-image-1', 'dall-e-3'],
    testPhase: 7
  }
}

export const PROVIDER_KIND_LIST = Object.values(PROVIDER_KINDS)

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** True for IPv4 literals in private, link-local (cloud metadata), CGNAT or unspecified ranges. */
export function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return (
    a === 0 ||
    a === 10 ||
    (a === 127 && host !== '127.0.0.1') ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

/** True for IPv6 literals that are unique-local, link-local, unspecified or map a private IPv4 address. */
export function isPrivateIPv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (!h.includes(':')) return false
  if (h === '::1') return false
  if (h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h)) return true
  // IPv4-mapped addresses, dotted (::ffff:10.0.0.1) or as URL parsers normalise them (::ffff:a00:1).
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h)?.[1]
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h)
  const v4 = dotted ?? (hex ? [parseInt(hex[1]!, 16) >> 8, parseInt(hex[1]!, 16) & 255, parseInt(hex[2]!, 16) >> 8, parseInt(hex[2]!, 16) & 255].join('.') : null)
  return v4 ? isPrivateIPv4(v4) || v4.startsWith('127.') : false
}

/**
 * Host names and literals that point inside a private network. Loopback is
 * not included — local servers on this computer are allowed. DNS answers are
 * checked again in the main process right before each request.
 */
export function isInternalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (LOOPBACK_HOSTS.has(host)) return false
  if (isPrivateIPv4(host) || isPrivateIPv6(host)) return true
  if (/\.(local|internal|lan|home|intranet|corp|localdomain|home\.arpa)$/.test(host) || host.endsWith('.localhost')) return true
  // Single-label names ("router", "llm-box") only resolve inside a local network.
  return !host.includes('.') && !host.includes(':')
}

export function isLoopbackEndpoint(value: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(value.trim()).hostname)
  } catch {
    return false
  }
}

/** Remote services need a key; local servers (LM Studio, Ollama…) usually don't. */
export function keyRequired(kind: ProviderKind, endpoint: string): boolean {
  return PROVIDER_KINDS[kind].requiresKey && !isLoopbackEndpoint(endpoint)
}

/**
 * Endpoint rules shared by the main process (authoritative) and the settings
 * form (instant feedback). Returns a human-readable problem, or null.
 */
export function validateEndpoint(kind: ProviderKind, value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return 'Enter an endpoint URL.'
  if (trimmed.length > 300) return 'Endpoint is too long.'
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return 'Enter a full URL, including http:// or https://.'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Use an http:// or https:// address.'
  if (url.username || url.password) return 'Do not put credentials in the URL — use the API key field.'
  if (url.search || url.hash) return 'Remove query strings and fragments from the endpoint.'
  const loopback = LOOPBACK_HOSTS.has(url.hostname)
  if (PROVIDER_KINDS[kind].loopbackOnly && !loopback) return 'This service runs locally — use 127.0.0.1 or localhost.'
  if (PROVIDER_KINDS[kind].blockPrivateNetwork && isInternalHost(url.hostname)) {
    return 'Private-network and internal addresses are not allowed. Use the provider’s public https:// endpoint, or a server on this computer (127.0.0.1).'
  }
  if (!loopback && url.protocol !== 'https:') return 'Remote endpoints must use https://.'
  return null
}

export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/

export function validateModel(kind: ProviderKind, value: string | null): string | null {
  const model = value?.trim() ?? ''
  if (!model) return PROVIDER_KINDS[kind].requiresModel ? 'Choose or enter a model.' : null
  return MODEL_PATTERN.test(model) ? null : 'Model names may use letters, numbers and . _ : / - only.'
}

export function validateProviderName(value: string): string | null {
  const name = value.trim()
  if (!name) return 'Give this configuration a name.'
  if (name.length > 60) return 'Keep the name under 60 characters.'
  return null
}
