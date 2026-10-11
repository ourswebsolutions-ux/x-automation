import type { AiAdapterId, AiAdapterMeta } from '@shared/config/aiAdapters'
import type { AiModelInfo, AiTokenUsage, FinishReason } from '@shared/types/ai'

/** Everything an adapter needs for one request. The key never leaves the main process. */
export interface AdapterContext {
  endpoint: string
  /** Decrypted key, or null for keyless local servers. */
  apiKey: string | null
  timeoutMs: number
  fetch: typeof fetch
  /** Base fetch for downloading result URLs (checked by fetchPublicImage itself). */
  fetchForDownloads?: typeof fetch
  signal?: AbortSignal
}

export interface AdapterTextRequest {
  model: string
  instructions: string | null
  input: string
  temperature: number | null
  maxOutputTokens: number | null
}

/** Provider response normalised to one shape, whatever the API. */
export interface AdapterTextResult {
  text: string
  model: string
  finishReason: FinishReason
  usage: AiTokenUsage | null
  providerRequestId: string | null
}

export interface AdapterImageRequest {
  model: string
  prompt: string
  size: string
  quality: string | null
  format: 'png' | 'jpeg' | 'webp' | null
  transparent: boolean
  n: number
  /** dall-e models return URLs unless base64 is requested. */
  requestBase64: boolean
}

export interface AdapterImageResult {
  images: { bytes: Buffer; revisedPrompt: string | null }[]
  model: string
  usage: AiTokenUsage | null
  providerRequestId: string | null
  /** As reported by the provider, when it says. */
  outputFormat: string | null
  size: string | null
}

/**
 * One way of talking to an AI provider. Adapters only translate requests and
 * responses; validation, provider resolution, usage logging and error
 * reporting live in AiService.
 */
export interface AiAdapter {
  readonly id: AiAdapterId
  readonly meta: AiAdapterMeta
  listModels(ctx: AdapterContext): Promise<AiModelInfo[]>
  /** Present only on adapters whose capabilities include text generation. */
  generateText?(ctx: AdapterContext, request: AdapterTextRequest): Promise<AdapterTextResult>
  /** Present only on adapters whose capabilities include image generation. */
  generateImages?(ctx: AdapterContext, request: AdapterImageRequest): Promise<AdapterImageResult>
}
