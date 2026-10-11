import type { ImageFormat } from '../config/imageModels'
import type { ImageMime } from '../config/mediaLimits'
import type { AiError, AiTokenUsage } from './ai'
import type { Id, Timestamp } from './domain'

export type AssetOrigin = 'upload' | 'generated'

/** An image in the local library. The file lives in the app's asset folder; this is its metadata. */
export interface ImageAsset {
  id: Id
  origin: AssetOrigin
  originalName: string
  mimeType: ImageMime
  width: number
  height: number
  sizeBytes: number
  animated: boolean
  /** Prompt used, for generated images. */
  prompt: string | null
  generationId: Id | null
  /** Generated images stay out of the library until saved or attached. */
  kept: boolean
  /** False when the file is no longer on disk. */
  available: boolean
  /** Drafts that attach this image. */
  usedBy: number
  /** URL for <img> (served by the main process from the asset folder by id). */
  url: string
  createdAt: Timestamp
}

export interface AssetQuery {
  search?: string
  origin?: AssetOrigin
  sort?: 'newest' | 'oldest' | 'largest' | 'name'
  /** Include generated images that were never saved or attached. */
  includeUnkept?: boolean
}

export interface ImportResult {
  imported: ImageAsset[]
  /** Files already in the library (same content) — the existing asset is returned. */
  existing: ImageAsset[]
  rejected: { name: string; reason: string }[]
  cancelled: boolean
}

export interface ImageGenerationRequest {
  prompt: string
  size: string
  quality: string | null
  format: ImageFormat | null
  transparent: boolean
  count: number
  draftId: Id | null
}

export interface ImageRunOptions {
  requestId: Id
  providerId?: Id
  model?: string
}

export type ImageGenerationStatus = 'succeeded' | 'failed' | 'cancelled'

export interface ImageGenerationRecord {
  id: Id
  status: ImageGenerationStatus
  providerId: Id | null
  providerName: string
  model: string | null
  prompt: string
  size: string
  quality: string | null
  format: string | null
  /** Ids of the assets created from this request. */
  assetIds: Id[]
  assets: ImageAsset[]
  revisedPrompt: string | null
  usage: AiTokenUsage | null
  error: Pick<AiError, 'kind' | 'message' | 'hint'> | null
  durationMs: number | null
  draftId: Id | null
  createdAt: Timestamp
}

export const IMAGE_STYLES = ['photographic', 'illustration', 'flat vector', '3D render', 'watercolor', 'minimal line art', 'cinematic'] as const
export type ImageStyle = (typeof IMAGE_STYLES)[number]

/** Ask the text provider for an image prompt that matches a post. */
export interface ImagePromptRequest {
  postText: string
  style: ImageStyle
  instructions: string
  requestId: Id
  providerId?: Id
  model?: string
}

export type ImagePromptOutcome =
  | { ok: true; prompt: string; providerName: string; model: string }
  | { ok: false; error: Pick<AiError, 'kind' | 'message' | 'hint'> }
