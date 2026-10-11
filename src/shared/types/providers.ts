import type { AiAdapterId } from '../config/aiAdapters'
import type { Id, Timestamp } from './domain'

export type ProviderKind = 'ixbrowser' | 'openai-compatible' | 'image'

/** What the renderer may know about a stored secret — never the secret itself. */
export interface CredentialSummary {
  /** Last four characters for recognition, e.g. "a1b2" (null for short keys). */
  hint: string | null
  updatedAt: Timestamp
  /** False when the reference exists but the encrypted value is gone (e.g. after a restore). */
  present: boolean
}

/** Optional generation parameters; null leaves the provider's own default in place. */
export interface GenerationDefaults {
  temperature: number | null
  maxOutputTokens: number | null
}

/** Per-configuration request behaviour (used by integrations that make HTTP calls). */
export interface ProviderSettings {
  /** Request timeout in milliseconds. */
  timeoutMs: number
  /** Extra attempts for safe, read-only requests (never for generation or actions like open/close). */
  retries: number
  /** AI text providers only. */
  generation?: GenerationDefaults
  /** Image providers only: defaults used by the image panel (validated against the model when generating). */
  image?: ImageDefaults
}

export interface ImageDefaults {
  size: string
  quality: string | null
  format: 'png' | 'jpeg' | 'webp' | null
}

export const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = { timeoutMs: 10_000, retries: 1 }
/** Generation can legitimately take a while; AI configurations start with a longer timeout. */
export const DEFAULT_AI_SETTINGS: ProviderSettings = { timeoutMs: 60_000, retries: 1, generation: { temperature: null, maxOutputTokens: null } }
/** Image generation can take a minute or more. */
export const DEFAULT_IMAGE_SETTINGS: ProviderSettings = { timeoutMs: 120_000, retries: 1, image: { size: '1024x1024', quality: null, format: null } }

export type ProviderReadinessState = 'disabled' | 'incomplete' | 'ready'

export interface ProviderReadiness {
  state: ProviderReadinessState
  issues: string[]
}

export interface ProviderConfig {
  id: Id
  kind: ProviderKind
  /** How an AI text provider is called (null for IX Browser and image configurations). */
  adapter: AiAdapterId | null
  name: string
  endpoint: string
  model: string | null
  enabled: boolean
  settings: ProviderSettings
  credential: CredentialSummary | null
  readiness: ProviderReadiness
  createdAt: Timestamp
  updatedAt: Timestamp
}

/** Editable, non-secret fields. Keys travel separately and write-only. */
export interface ProviderInput {
  kind: ProviderKind
  /** Required for AI text configurations; ignored otherwise. */
  adapter?: AiAdapterId | null
  name: string
  endpoint: string
  model: string | null
  enabled: boolean
  settings?: ProviderSettings
}
