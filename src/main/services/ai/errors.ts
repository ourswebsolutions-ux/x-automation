import OpenAI from 'openai'
import type { AiError, AiErrorKind } from '@shared/types/ai'
import { redact } from '../logging/logger'

/** An AI failure with a user-facing message. Never carries a secret. */
export class AiServiceError extends Error {
  constructor(
    readonly kind: AiErrorKind,
    message: string,
    readonly hint = '',
    readonly status: number | null = null,
    readonly code: string | null = null,
    readonly retryAfterSec: number | null = null
  ) {
    super(message)
    this.name = 'AiServiceError'
  }

  toJSON(): AiError {
    return { kind: this.kind, message: this.message, hint: this.hint, status: this.status, code: this.code, retryAfterSec: this.retryAfterSec }
  }
}

/**
 * Provider messages can echo part of the key (OpenAI's 401 does, masked) or
 * the request. Strip anything key-like and keep it short.
 */
export function sanitizeProviderMessage(message: unknown): string {
  if (typeof message !== 'string') return ''
  return redact(message)
    .replace(/(provided|key)\s*:\s*\S+/gi, '$1: [redacted]')
    .replace(/\b(sk|pk|rk|key|gsk|xai|tok)[-_][A-Za-z0-9*._-]{4,}/gi, '[redacted]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

const NETWORK_MESSAGES: Record<string, string> = {
  ENOTFOUND: 'The provider’s host name could not be found.',
  EAI_AGAIN: 'The provider’s host name could not be resolved right now.',
  ECONNREFUSED: 'Nothing is accepting connections at that address.',
  ECONNRESET: 'The connection was reset by the provider.',
  ETIMEDOUT: 'The connection timed out.',
  CERT_HAS_EXPIRED: 'The provider’s TLS certificate has expired.',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'The provider uses a self-signed TLS certificate, which is not trusted.',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'The provider’s TLS certificate could not be verified.',
  ERR_TLS_CERT_ALTNAME_INVALID: 'The provider’s TLS certificate does not match its host name.'
}

/** Walks `cause` chains (fetch wraps errors several levels deep). */
function causes(error: unknown): unknown[] {
  const chain: unknown[] = []
  let current: unknown = error
  for (let i = 0; current && i < 6; i++) {
    chain.push(current)
    current = (current as { cause?: unknown }).cause
  }
  return chain
}

function retryAfter(headers: Headers | undefined): number | null {
  const value = headers?.get?.('retry-after')
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds))
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, Math.round((date - Date.now()) / 1000)) : null
}

const mentionsModel = (text: string) => /\bmodel\b/i.test(text) && /(does not exist|not found|not supported|unsupported|do not have access|invalid model|unknown model)/i.test(text)

/** Maps SDK, network and abort errors to a small set of kinds with clear messages. */
export function classifyError(error: unknown, context: { operation: 'list-models' | 'generate-text'; model?: string | null }): AiServiceError {
  for (const item of causes(error)) if (item instanceof AiServiceError) return item

  if (error instanceof OpenAI.APIUserAbortError) return new AiServiceError('cancelled', 'Request cancelled.')
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return new AiServiceError('timeout', 'The provider did not answer in time.', 'Try again, or raise the request timeout in the provider settings.')
  }
  if (error instanceof OpenAI.APIConnectionError) {
    const code = causes(error)
      .map((c) => (c as { code?: unknown }).code)
      .find((c): c is string => typeof c === 'string')
    return new AiServiceError(
      'network',
      (code && NETWORK_MESSAGES[code]) ?? 'Could not reach the provider.',
      'Check your internet connection and the endpoint URL.',
      null,
      code ?? null
    )
  }

  if (error instanceof OpenAI.APIError && typeof error.status === 'number') {
    const status = error.status
    const code = typeof error.code === 'string' ? error.code : null
    const detail = sanitizeProviderMessage((error.error as { message?: unknown } | undefined)?.message ?? error.message)
    const model = context.model ? `“${context.model}”` : 'the selected model'

    if (status === 401) {
      return new AiServiceError('auth', 'The API key was rejected.', 'Check that the key is correct and still active, then replace it in the provider settings.', status, code)
    }
    if (status === 403) {
      return new AiServiceError('auth', 'This key is not allowed to make that request.', detail || 'Check the key’s permissions, project and region in the provider’s dashboard.', status, code)
    }
    if (status === 429) {
      if (code === 'insufficient_quota' || /quota|billing|credit/i.test(detail)) {
        return new AiServiceError('quota', 'The account has run out of quota or credit.', 'Check the plan and billing details in the provider’s dashboard.', status, code)
      }
      const wait = retryAfter(error.headers as Headers | undefined)
      return new AiServiceError('rate-limit', 'The provider is rate-limiting requests.', wait ? `Try again in about ${wait} s.` : 'Wait a moment and try again.', status, code, wait)
    }
    if (code === 'unsupported_parameter' || code === 'unsupported_value') {
      const param = typeof error.param === 'string' ? error.param : null
      return new AiServiceError(
        'invalid-request',
        param ? `${model} does not accept the “${param}” setting.` : `${model} rejected one of the generation settings.`,
        'Clear that generation default (leave it empty to use the provider’s own default).',
        status,
        code
      )
    }
    if (code === 'model_not_found' || (status === 404 && context.operation === 'generate-text' && mentionsModel(detail)) || ((status === 400 || status === 422) && mentionsModel(detail))) {
      return new AiServiceError('model', `The provider does not offer ${model} to this key.`, 'Refresh the model list and choose one it lists.', status, code)
    }
    if (status === 404) {
      return new AiServiceError(
        'invalid-request',
        context.operation === 'list-models' ? 'This endpoint has no model list (GET /models was not found).' : 'The provider has no such endpoint.',
        'Check the endpoint URL — it usually ends in /v1. Some compatible servers do not list models; use “Try a prompt” instead.',
        status,
        code
      )
    }
    if (status === 408) return new AiServiceError('timeout', 'The provider timed out handling the request.', 'Try again.', status, code)
    if (status >= 500) {
      return new AiServiceError('server', 'The provider had a problem handling the request.', detail ? `It said: ${detail}` : 'Try again later.', status, code)
    }
    return new AiServiceError('invalid-request', 'The provider rejected the request.', detail, status, code)
  }

  if (error instanceof OpenAI.OpenAIError || error instanceof SyntaxError) {
    return new AiServiceError('malformed', 'The provider’s response was not in the expected format.', 'Check that the endpoint is an OpenAI-compatible API.')
  }
  return new AiServiceError('malformed', 'The request failed unexpectedly.', '')
}
