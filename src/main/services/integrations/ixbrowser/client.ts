import type { IxError, IxErrorKind } from '@shared/types/ixbrowser'
import { redact } from '../../logging/logger'
import { envelopeSchema, openedIds, openResultSchema, paginatedSchema, toProfileRecord } from './schemas'
import { IX_ACTIONS, IX_API_PATH, type IxAction, type IxOpenResult, type IxProfilePage, type IxProfileRecord } from './types'

export class IxBrowserError extends Error {
  constructor(
    readonly kind: IxErrorKind,
    message: string,
    readonly hint: string,
    readonly code: number | null = null
  ) {
    super(message)
    this.name = 'IxBrowserError'
  }

  toJSON(): IxError {
    return { kind: this.kind, message: this.message, hint: this.hint, code: this.code }
  }
}

export interface IxClientOptions {
  /** Base endpoint, e.g. http://127.0.0.1:53200 (an /api/v2 suffix is tolerated). */
  endpoint: string
  timeoutMs: number
  retries: number
  fetchImpl?: typeof fetch
}

/** Actions that read state and are safe to repeat. open/close are never retried. */
const READ_ONLY = new Set<IxAction>([IX_ACTIONS.profileList, IX_ACTIONS.openedByApi, IX_ACTIONS.openedByClient])
const PAGE_SIZE = 100
const MAX_PAGES = 500 // 50,000 profiles — a guard against a server that never ends pagination

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new IxBrowserError('cancelled', 'Cancelled.', ''))
    }, { once: true })
  })

export function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '').replace(/\/api\/v2$/i, '')
}

/**
 * Typed client for the IX Browser Local API V2. Every response is validated
 * at runtime; every failure becomes an IxBrowserError with a user-facing hint.
 */
export class IxBrowserHttpClient {
  private readonly base: string
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: IxClientOptions) {
    this.base = `${normalizeEndpoint(options.endpoint)}${IX_API_PATH}`
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /** One real profile-list request (page 1, 1 item) — used as the connection test. */
  async ping(signal?: AbortSignal): Promise<{ latencyMs: number; total: number }> {
    const started = performance.now()
    const page = await this.listProfilesPage(1, 1, signal)
    return { latencyMs: Math.round(performance.now() - started), total: page.total }
  }

  async listProfilesPage(page: number, limit: number, signal?: AbortSignal): Promise<IxProfilePage> {
    const data = await this.call(IX_ACTIONS.profileList, { page, limit }, signal)
    const parsed = paginatedSchema.safeParse(data)
    if (!parsed.success) throw this.malformed('profile-list did not return { total, data[] }')
    const items: IxProfileRecord[] = []
    for (const raw of parsed.data.data ?? []) {
      const record = toProfileRecord(raw)
      if (!record) throw this.malformed('profile-list returned a profile without a valid profile_id')
      items.push(record)
    }
    return { total: parsed.data.total, items }
  }

  /** Walks every page. Stops on the reported total, an empty page, or the page guard. */
  async listAllProfiles(signal?: AbortSignal, onPage?: (fetched: number, total: number) => void): Promise<IxProfileRecord[]> {
    const all: IxProfileRecord[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const result = await this.listProfilesPage(page, PAGE_SIZE, signal)
      all.push(...result.items)
      onPage?.(all.length, result.total)
      if (result.items.length === 0 || all.length >= result.total) return all
    }
    throw this.malformed(`Pagination did not finish after ${MAX_PAGES} pages`)
  }

  /**
   * Profiles currently open, from both documented lists. The desktop-client
   * list may not exist on older builds; that is reported, not treated as fatal.
   */
  async openedProfiles(signal?: AbortSignal): Promise<{ api: number[]; client: number[] | null }> {
    const api = openedIds(await this.call(IX_ACTIONS.openedByApi, {}, signal))
    if (!api) throw this.malformed('profile-opened-list did not return a list')
    let client: number[] | null = null
    try {
      client = openedIds(await this.call(IX_ACTIONS.openedByClient, {}, signal))
    } catch (error) {
      if (!(error instanceof IxBrowserError) || (error.kind !== 'unsupported' && error.kind !== 'api')) throw error
    }
    return { api, client }
  }

  async openProfile(profileId: number, signal?: AbortSignal): Promise<IxOpenResult> {
    // Parameters as sent by the official client's open_profile() defaults.
    const data = await this.call(
      IX_ACTIONS.open,
      {
        profile_id: profileId,
        load_extensions: true,
        load_profile_info_page: false,
        cookies_backup: true,
        args: ['--disable-extension-welcome-page']
      },
      signal
    )
    const parsed = openResultSchema.safeParse(data === true ? null : data)
    if (!parsed.success) throw this.malformed('profile-open returned an unexpected result')
    return { debuggingAddress: parsed.data?.debugging_address ?? null }
  }

  /**
   * Sets a profile to custom proxy mode with the documented payload of the
   * official SDK's update_profile_to_custom_proxy_mode() (proxy_mode 2). A
   * write action: never retried. The password is sent to the local IX Browser
   * API only and is never logged.
   */
  async updateCustomProxy(
    profileId: number,
    proxy: { type: 'http' | 'https' | 'socks5'; host: string; port: number; username: string | null; password: string | null },
    signal?: AbortSignal
  ): Promise<void> {
    const proxyInfo: Record<string, unknown> = { proxy_mode: 2, proxy_type: proxy.type, proxy_check_line: 'global_line', proxy_ip: proxy.host, proxy_port: proxy.port }
    if (proxy.username) proxyInfo.proxy_user = proxy.username
    if (proxy.password) proxyInfo.proxy_password = proxy.password
    await this.call(IX_ACTIONS.updateCustomProxy, { profile_id: profileId, proxy_info: proxyInfo }, signal)
  }

  async closeProfile(profileId: number, signal?: AbortSignal): Promise<void> {
    await this.call(IX_ACTIONS.close, { profile_id: profileId }, signal)
  }

  private async call(action: IxAction, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const attempts = READ_ONLY.has(action) ? this.options.retries + 1 : 1
    let lastError: IxBrowserError | null = null
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.once(action, body, signal)
      } catch (error) {
        lastError = error as IxBrowserError
        const transient = lastError.kind === 'unreachable' || lastError.kind === 'timeout' || (lastError.kind === 'http' && (lastError.code ?? 0) >= 500)
        if (!transient || attempt === attempts) throw lastError
        await wait(250 * 2 ** (attempt - 1), signal)
      }
    }
    throw lastError ?? new IxBrowserError('unreachable', 'Request failed.', '')
  }

  private async once(action: IxAction, body: Record<string, unknown>, outer?: AbortSignal): Promise<unknown> {
    if (outer?.aborted) throw new IxBrowserError('cancelled', 'Cancelled.', '')
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.options.timeoutMs)
    const relay = () => controller.abort()
    outer?.addEventListener('abort', relay, { once: true })

    let response: Response
    try {
      response = await this.fetchImpl(`${this.base}${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error'
      })
    } catch {
      if (timedOut) {
        throw new IxBrowserError(
          'timeout',
          `IX Browser did not answer within ${Math.round(this.options.timeoutMs / 1000)} s.`,
          'IX Browser may be busy. Try again, or raise the timeout in the connection settings.'
        )
      }
      if (outer?.aborted) throw new IxBrowserError('cancelled', 'Cancelled.', '')
      throw new IxBrowserError(
        'unreachable',
        'Could not reach IX Browser at this address.',
        'Start IX Browser, enable the Local API in its settings, and check the port.'
      )
    } finally {
      clearTimeout(timer)
      outer?.removeEventListener('abort', relay)
    }

    if (response.status === 404) {
      throw new IxBrowserError(
        'unsupported',
        `This server does not provide the Local API V2 action "${action}".`,
        'Update IX Browser to a version with Local API V2, or check that the endpoint points to IX Browser.',
        404
      )
    }
    if (response.status !== 200) {
      throw new IxBrowserError('http', `IX Browser answered with HTTP ${response.status}.`, 'Check the Local API settings in IX Browser.', response.status)
    }

    let json: unknown
    try {
      const text = await response.text()
      if (text.length > 20_000_000) throw new Error('too large')
      json = JSON.parse(text)
    } catch {
      throw this.malformed('The response was not valid JSON')
    }
    const envelope = envelopeSchema.safeParse(json)
    if (!envelope.success) throw this.malformed('The response did not contain the documented { error: { code } } envelope')
    const { code, message } = envelope.data.error
    if (code !== 0) {
      const safe = message ? redact(message).slice(0, 300) : null
      throw new IxBrowserError(
        'api',
        safe ? `IX Browser reported an error: ${safe}` : `IX Browser reported error code ${code}.`,
        'Check your IX Browser plan, sign-in state and that the Local API is enabled.',
        code
      )
    }
    return 'data' in envelope.data ? envelope.data.data : true
  }

  private malformed(detail: string): IxBrowserError {
    return new IxBrowserError('malformed', `Unexpected response from IX Browser: ${detail}.`, 'Make sure the endpoint points to IX Browser’s Local API (V2).')
  }
}
