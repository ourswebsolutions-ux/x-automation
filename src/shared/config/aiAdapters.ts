/**
 * AI text adapters: how X Auto talks to a provider. Each adapter declares
 * what it can do, so the app never assumes every provider supports the same
 * API, parameters or usage reporting.
 *
 * No model names are hard-coded: models come from the provider's own model
 * list (or are typed by the user). The only model knowledge here is a list of
 * id patterns that are clearly not text-generation models, used to tidy the
 * picker — anything else the provider lists is shown.
 */

export type AiAdapterId = 'openai' | 'openai-chat' | 'openai-images'

export type AiOperation = 'connection-test' | 'list-models' | 'generate-text' | 'generate-image'

export interface NumericParam {
  min: number
  max: number
  step: number
}

export interface AiAdapterMeta {
  id: AiAdapterId
  label: string
  description: string
  /** API surface used for generation, shown in settings for transparency. */
  api: string
  defaultName: string
  defaultEndpoint: string
  /** Whether the endpoint is normally changed (compatible services) or left as is (OpenAI). */
  endpointEditable: boolean
  docsUrl: string
  capabilities: {
    textGeneration: boolean
    /** GET /models is part of the API (some compatible servers return partial lists). */
    modelListing: boolean
    imageGeneration: boolean
    /** Request cancellation via AbortSignal. */
    cancellation: boolean
    /** Token usage: 'reported' = documented in every response; 'when-provided' = depends on the server. */
    usage: 'reported' | 'when-provided'
  }
  parameters: {
    temperature: NumericParam
    maxOutputTokens: NumericParam
  }
  /** Operations the application may perform through this adapter. */
  operations: AiOperation[]
}

export const AI_ADAPTERS: Record<AiAdapterId, AiAdapterMeta> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    description: 'OpenAI’s own API. Text is generated with the Responses API.',
    api: 'Responses API · POST /responses',
    defaultName: 'OpenAI',
    defaultEndpoint: 'https://api.openai.com/v1',
    endpointEditable: false,
    docsUrl: 'https://platform.openai.com/docs/api-reference/responses',
    capabilities: { textGeneration: true, modelListing: true, imageGeneration: false, cancellation: true, usage: 'reported' },
    parameters: {
      temperature: { min: 0, max: 2, step: 0.1 },
      maxOutputTokens: { min: 16, max: 128_000, step: 1 }
    },
    operations: ['connection-test', 'list-models', 'generate-text']
  },
  'openai-chat': {
    id: 'openai-chat',
    label: 'OpenAI-compatible',
    description: 'Any service exposing the Chat Completions API — hosted providers, or local servers such as LM Studio or Ollama.',
    api: 'Chat Completions API · POST /chat/completions',
    defaultName: 'Compatible provider',
    defaultEndpoint: 'http://127.0.0.1:1234/v1',
    endpointEditable: true,
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
    capabilities: { textGeneration: true, modelListing: true, imageGeneration: false, cancellation: true, usage: 'when-provided' },
    parameters: {
      temperature: { min: 0, max: 2, step: 0.1 },
      maxOutputTokens: { min: 1, max: 128_000, step: 1 }
    },
    operations: ['connection-test', 'list-models', 'generate-text']
  },
  'openai-images': {
    id: 'openai-images',
    label: 'OpenAI Images API',
    description: 'OpenAI’s image generation, or a service exposing the same Images API.',
    api: 'Images API · POST /images/generations',
    defaultName: 'OpenAI Images',
    defaultEndpoint: 'https://api.openai.com/v1',
    endpointEditable: true,
    docsUrl: 'https://platform.openai.com/docs/api-reference/images/create',
    capabilities: { textGeneration: false, modelListing: true, imageGeneration: true, cancellation: true, usage: 'when-provided' },
    parameters: {
      temperature: { min: 0, max: 0, step: 0 },
      maxOutputTokens: { min: 0, max: 0, step: 0 }
    },
    operations: ['connection-test', 'list-models', 'generate-image']
  }
}

export const AI_ADAPTER_LIST = Object.values(AI_ADAPTERS)
/** Adapters for AI text providers (the image adapter is configured under Image generation). */
export const TEXT_ADAPTER_LIST = AI_ADAPTER_LIST.filter((a) => a.capabilities.textGeneration)

export const isAiAdapterId = (value: unknown): value is AiAdapterId => typeof value === 'string' && value in AI_ADAPTERS

/**
 * Model id families that are documented as non-text (embeddings, speech,
 * images, moderation). Hidden from the text model picker by default; the user
 * can still show all models or type any id.
 */
export const NON_TEXT_MODEL_PATTERNS: RegExp[] = [
  /embed/i,
  /whisper/i,
  /\btts\b|-tts/i,
  /transcribe/i,
  /dall-e/i,
  /gpt-image/i,
  /moderation/i,
  /\b(davinci|babbage)-00/i,
  /realtime/i,
  /audio/i,
  /^sora/i
]

export const isLikelyTextModel = (id: string) => !NON_TEXT_MODEL_PATTERNS.some((pattern) => pattern.test(id))

/** Prompt used by "Try a prompt" in settings — short so the test costs very little. */
export const TEST_PROMPT_MAX_CHARS = 500
export const TEST_PROMPT_MAX_OUTPUT_TOKENS = 200
