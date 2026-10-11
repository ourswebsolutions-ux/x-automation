import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { isPrivateIPv4, isPrivateIPv6 } from '@shared/config/providers'
import { AiServiceError } from './errors'

export type LookupFn = (host: string) => Promise<{ address: string; family: number }[]>

const defaultLookup: LookupFn = (host) => dnsLookup(host, { all: true, verbatim: true })

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1'])
const isLoopbackAddress = (address: string) => /^127\./.test(address) || address === '::1' || /^::ffff:127\./i.test(address)

const blocked = (detail: string) =>
  new AiServiceError(
    'blocked-endpoint',
    'That endpoint points into a private network, so the request was not sent.',
    `${detail} Use the provider’s public https:// endpoint, or a server on this computer at 127.0.0.1.`
  )

/**
 * Refuses destinations inside private networks. Endpoints configured as
 * loopback (127.0.0.1 / localhost — local model servers) are allowed; a
 * public host name that resolves to a private or loopback address is not
 * (DNS rebinding). Settings validation already rejects private literals; this
 * repeats the check with real DNS answers right before each request.
 */
export async function assertAllowedDestination(url: URL, lookup: LookupFn = defaultLookup): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (LOOPBACK_NAMES.has(host)) return
  if (isIP(host)) {
    if (isPrivateIPv4(host) || isPrivateIPv6(host) || isLoopbackAddress(host)) throw blocked(`${host} is a private address.`)
    return
  }
  let answers: { address: string }[]
  try {
    answers = await lookup(host)
  } catch (error) {
    const code = (error as { code?: string }).code
    throw new AiServiceError('network', 'The provider’s host name could not be found.', 'Check the endpoint URL and your internet connection.', null, code ?? null)
  }
  for (const { address } of answers) {
    if (isPrivateIPv4(address) || isPrivateIPv6(address) || isLoopbackAddress(address)) {
      throw blocked(`${host} resolves to a private address.`)
    }
  }
}

/**
 * fetch for the AI SDK: only the configured origin, DNS-checked, and no
 * redirects (a redirect could otherwise lead the key to another host).
 */
export function createGuardedFetch(endpoint: string, options: { fetchImpl?: typeof fetch; lookup?: LookupFn } = {}): typeof fetch {
  const origin = new URL(endpoint).origin
  const base = options.fetchImpl ?? fetch
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.origin !== origin) throw blocked(`Requests may only go to ${origin}.`)
    await assertAllowedDestination(url, options.lookup)
    return base(input, { ...init, redirect: 'error' })
  }
}

/**
 * Downloads a generated image from a provider's result URL: https only,
 * public destinations only (DNS-checked), no redirects, size-capped.
 */
export async function fetchPublicImage(
  rawUrl: string,
  options: { fetchImpl?: typeof fetch; lookup?: LookupFn; signal?: AbortSignal; maxBytes: number; timeoutMs: number }
): Promise<Buffer> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new AiServiceError('malformed', 'The provider returned an invalid image link.')
  }
  if (url.protocol !== 'https:') throw new AiServiceError('blocked-endpoint', 'The provider returned an image link that is not https, so it was not downloaded.')
  await assertAllowedDestination(url, options.lookup)
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  let response: Response
  try {
    response = await (options.fetchImpl ?? fetch)(url, { redirect: 'error', signal })
  } catch (error) {
    if (options.signal?.aborted) throw new AiServiceError('cancelled', 'Request cancelled.')
    if (timeout.aborted) throw new AiServiceError('timeout', 'Downloading the generated image timed out.')
    throw new AiServiceError('network', 'The generated image could not be downloaded.', '', null, (error as { code?: string }).code ?? null)
  }
  if (!response.ok || !response.body) throw new AiServiceError('server', `The generated image could not be downloaded (HTTP ${response.status}).`)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > options.maxBytes) throw new AiServiceError('malformed', 'The generated image is unexpectedly large.')
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength
    if (total > options.maxBytes) throw new AiServiceError('malformed', 'The generated image is unexpectedly large.')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}
