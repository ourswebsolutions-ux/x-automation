import type { AiAdapterId, AiOperation } from '../config/aiAdapters'
import type { Id, Timestamp } from './domain'

/** Why an AI request failed. Messages are written for users and never contain secrets. */
export type AiErrorKind =
  | 'not-configured' // no usable provider / key / model
  | 'blocked-endpoint' // endpoint resolves to a private or internal address
  | 'auth' // invalid or revoked key, or no permission
  | 'quota' // billing quota exhausted
  | 'usage-limit' // a usage limit set in X Auto was reached
  | 'rate-limit' // too many requests — try later
  | 'model' // model does not exist or is not available to this key
  | 'invalid-request' // the provider rejected a parameter
  | 'timeout'
  | 'network' // could not reach the provider
  | 'server' // provider-side failure (5xx)
  | 'malformed' // response did not match the documented format
  | 'cancelled'

export interface AiError {
  kind: AiErrorKind
  message: string
  hint: string
  /** HTTP status when the provider answered. */
  status: number | null
  /** Provider error code (e.g. "insufficient_quota"), when supplied. */
  code: string | null
  /** Seconds to wait, from the provider's Retry-After header. */
  retryAfterSec: number | null
}

/** Provider-reported token counts. Never estimated. */
export interface AiTokenUsage {
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
}

export interface AiConnectionTest {
  ok: boolean
  providerId: Id
  checkedAt: Timestamp
  latencyMs: number | null
  /** Models the key can see (from GET /models), when listed. */
  modelCount: number | null
  /** Whether the configured model appears in the provider's list (null: not listed / no model set). */
  modelListed: boolean | null
  error: AiError | null
}

export interface AiModelInfo {
  id: string
  ownedBy: string | null
  /** False for ids that match documented non-text families (embeddings, speech, images…). */
  likelyText: boolean
}

export interface AiModelList {
  providerId: Id
  fetchedAt: Timestamp
  models: AiModelInfo[]
}

/**
 * Text generation request used by the main-process AI service. Phase 6 builds
 * the tweet generator on this; the renderer only reaches it through specific,
 * validated operations.
 */
export interface TextGenerationRequest {
  /** Defaults to the default text provider. */
  providerId?: Id
  /** Defaults to the provider's configured model. */
  model?: string
  /** System / developer instructions. */
  instructions?: string
  input: string
  /** Overrides the provider's generation defaults; null = provider default. */
  temperature?: number | null
  maxOutputTokens?: number | null
  operation?: Extract<AiOperation, 'generate-text'>
}

export type FinishReason = 'stop' | 'length' | 'content-filter' | 'other'

export interface TextGenerationResult {
  text: string
  providerId: Id
  providerName: string
  adapter: AiAdapterId
  /** Model id as reported by the provider (may be more specific than requested). */
  model: string
  finishReason: FinishReason
  usage: AiTokenUsage | null
  latencyMs: number
  /** Provider request id, for support tickets. */
  providerRequestId: string | null
  usageRecordId: Id
}

export type AiRequestStatus = 'succeeded' | 'failed' | 'cancelled'

export interface AiUsageRecord {
  id: Id
  providerId: Id | null
  providerName: string
  adapter: AiAdapterId
  model: string | null
  operation: AiOperation
  status: AiRequestStatus
  errorKind: AiErrorKind | null
  startedAt: Timestamp
  durationMs: number | null
  /** Tokens exactly as reported by the provider; null when it reported none. */
  usage: AiTokenUsage | null
  imageCount: number | null
  imageSize: string | null
  imageFormat: string | null
  imageQuality: string | null
  /** Only set when reliable pricing data exists (not yet). */
  estimatedCostUsd: number | null
  providerRequestId: string | null
}

export interface AiUsageQuery {
  providerId?: Id
  operation?: AiOperation
  status?: AiRequestStatus
  /** Inclusive ISO bounds. */
  from?: Timestamp
  to?: Timestamp
  limit?: number
}

export interface AiUsageSummary {
  requests: number
  succeeded: number
  failed: number
  cancelled: number
  /** Requests whose response carried token usage. */
  withUsage: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface AiOverview {
  /** Last connection test per provider id. */
  tests: Record<Id, AiConnectionTest>
  /** Requests currently in flight (cancellable). */
  inFlight: { requestId: Id; providerId: Id; operation: AiOperation; startedAt: Timestamp }[]
}

export type TestPromptOutcome = { ok: true; result: TextGenerationResult } | { ok: false; error: AiError }

export interface TestPromptInput {
  providerId: Id
  /** Client-chosen id so the request can be cancelled while it runs. */
  requestId: Id
  prompt: string
  model?: string
}
