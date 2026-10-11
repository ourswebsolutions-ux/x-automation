import type { LengthProfileId } from '../config/postLimits'
import type { AiError, AiTokenUsage, FinishReason } from './ai'
import type { Id, Timestamp } from './domain'

export const TONES = ['professional', 'informative', 'conversational', 'educational', 'humorous', 'promotional', 'inspirational'] as const
export type Tone = (typeof TONES)[number]

export const LANGUAGES = [
  'English', 'Spanish', 'French', 'German', 'Portuguese', 'Italian', 'Dutch', 'Polish', 'Turkish', 'Russian', 'Arabic',
  'Urdu', 'Hindi', 'Bengali', 'Indonesian', 'Vietnamese', 'Japanese', 'Korean', 'Chinese (Simplified)', 'Chinese (Traditional)'
] as const

export type PostLength = 'short' | 'medium' | 'long'

/** Everything the user can specify for a generation. Validated in the main process. */
export interface GenerationBrief {
  topic: string
  keyPoints: string
  audience: string
  tone: Tone
  language: string
  length: PostLength
  variations: number
  /** Hashtags to include (without "#"). */
  hashtags: string[]
  /** Let the model suggest fitting hashtags as well. */
  suggestHashtags: boolean
  callToAction: string
  instructions: string
  lengthProfile: LengthProfileId
}

export const ASSIST_TOOLS = ['rewrite', 'improve', 'shorten', 'expand', 'tone', 'translate', 'alternatives', 'hashtags', 'opening', 'cta'] as const
export type AssistTool = (typeof ASSIST_TOOLS)[number]

export interface AssistRequest {
  tool: AssistTool
  /** The draft text the tool works on (body only; hashtags are passed separately). */
  text: string
  hashtags: string[]
  draftId: Id | null
  /** For "tone". */
  tone?: Tone
  /** For "translate". */
  language?: string
  /** For tools that return alternatives (1–5). */
  variations?: number
  lengthProfile: LengthProfileId
}

export type GenerationOperation = 'generate' | AssistTool

export interface GenerationRunOptions {
  /** Client-chosen id so the request can be cancelled (relay.ai.cancel). */
  requestId: Id
  providerId?: Id
  model?: string
}

export type GenerationStatus = 'succeeded' | 'failed' | 'cancelled'

/** One generation request and what came back. Contains no secrets. */
export interface GenerationRecord {
  id: Id
  operation: GenerationOperation
  status: GenerationStatus
  providerId: Id | null
  providerName: string
  model: string | null
  /** The brief or tool options used. */
  settings: GenerationBrief | Omit<AssistRequest, 'text' | 'hashtags'>
  /** Text sent to an editing tool (null for new generations). */
  sourceText: string | null
  /** Post variations, or hashtags (without "#") for the hashtag tool. */
  results: string[]
  draftId: Id | null
  finishReason: FinishReason | null
  error: Pick<AiError, 'kind' | 'message' | 'hint'> | null
  usage: AiTokenUsage | null
  durationMs: number | null
  createdAt: Timestamp
}

export interface GenerationHistoryQuery {
  limit?: number
  draftId?: Id
  operation?: 'generate' | 'assist'
}
