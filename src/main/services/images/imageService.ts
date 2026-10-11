import { randomUUID } from 'node:crypto'
import { imageModelCapabilities } from '@shared/config/imageModels'
import {
  IMAGE_STYLES,
  type ImageAsset,
  type ImageGenerationRecord,
  type ImageGenerationRequest,
  type ImagePromptOutcome,
  type ImagePromptRequest,
  type ImageRunOptions
} from '@shared/types/images'
import type { AiService } from '../ai/aiService'
import { AiServiceError } from '../ai/errors'
import type { AssetService } from '../assets/assetService'
import type { ImageGenerationRepository, StoredImageGeneration } from '../database/sqlite/imageGenerationRepository'
import { NotFoundError, ValidationError } from '../errors'
import type { ScopedLogger } from '../logging/logger'
import type { PreferencesStore } from '../preferences/preferencesStore'
import type { ProviderService } from '../providers/providerService'

interface Deps {
  ai: AiService
  assets: AssetService
  providers: ProviderService
  preferences: PreferencesStore
  generations: ImageGenerationRepository
  log: ScopedLogger
}

const EXTENSION: Record<string, string> = { png: 'png', jpeg: 'jpg', webp: 'webp' }

/**
 * Image generation for posts. Parameters are checked against what the chosen
 * model documents (shared/config/imageModels.ts) before anything is sent.
 * Returned images are validated and saved to the asset folder as "not kept"
 * until the user saves or attaches them — a billed result is never lost, and
 * nothing is shown that the provider did not return.
 */
export class ImageService {
  constructor(private readonly deps: Deps) {}

  async generate(input: ImageGenerationRequest, options: ImageRunOptions): Promise<ImageGenerationRecord> {
    const prompt = input.prompt.trim()
    if (!prompt) throw new ValidationError('Describe the image you want first.')
    const providerId = options.providerId ?? this.deps.preferences.get().defaults.imageProviderId ?? undefined
    const config = providerId ? this.safeProvider(providerId) : null
    if (config && config.kind !== 'image') throw new ValidationError('That configuration is not an image provider — choose one under Settings → Image generation.')
    if (!config) {
      // Recorded like any other failed request, so the history explains what happened.
      const missing: StoredImageGeneration = {
        id: randomUUID(),
        status: 'failed',
        providerId: null,
        providerName: providerId ? 'Removed provider' : 'No provider',
        model: options.model ?? null,
        prompt,
        size: input.size,
        quality: input.quality,
        format: input.format,
        assetIds: [],
        revisedPrompt: null,
        usage: null,
        error: {
          kind: 'not-configured',
          message: providerId ? 'That image provider no longer exists.' : 'No image provider is selected.',
          hint: 'Choose a default image provider in Settings → Image generation.'
        },
        durationMs: 0,
        draftId: null,
        createdAt: new Date().toISOString()
      }
      this.deps.generations.insert(missing, null)
      return { ...missing, assets: [] }
    }
    const model = options.model ?? config?.model ?? null
    const caps = imageModelCapabilities(model)
    if (prompt.length > caps.maxPromptChars) throw new ValidationError(`${caps.family} prompts can be up to ${caps.maxPromptChars.toLocaleString()} characters.`)
    if (!caps.sizes.includes(input.size)) throw new ValidationError(`${caps.family} supports these sizes: ${caps.sizes.join(', ')}.`)
    if (input.quality !== null && !(caps.qualities ?? []).includes(input.quality)) throw new ValidationError(`That quality isn’t available for ${caps.family}.`)
    if (input.format !== null && !(caps.formats ?? []).includes(input.format)) throw new ValidationError(`That output format isn’t available for ${caps.family}.`)
    if (input.transparent && !caps.transparentBackground) throw new ValidationError(`${caps.family} can’t make transparent backgrounds.`)
    if (input.transparent && input.format === 'jpeg') throw new ValidationError('Transparent backgrounds need PNG or WEBP.')
    if (!Number.isInteger(input.count) || input.count < 1 || input.count > caps.maxImages) throw new ValidationError(`${caps.family} can make 1–${caps.maxImages} image(s) per request.`)

    const started = Date.now()
    const base = {
      id: randomUUID(),
      prompt,
      size: input.size,
      quality: input.quality,
      format: input.format,
      draftId: input.draftId && this.deps.generations.draftExists(input.draftId) ? input.draftId : null,
      createdAt: new Date(started).toISOString()
    }
    let stored: StoredImageGeneration
    let usageRecordId: string | null = null
    let assets: ImageAsset[] = []
    try {
      const result = await this.deps.ai.generateImages(
        { providerId, model: model ?? undefined, prompt, size: input.size, quality: input.quality, format: input.format, transparent: input.transparent, n: input.count, requestBase64: caps.requestBase64 },
        { requestId: options.requestId }
      )
      usageRecordId = result.usageRecordId
      const rejected: string[] = []
      // The record must exist before assets point at it.
      stored = {
        ...base,
        status: 'succeeded',
        providerId: result.providerId,
        providerName: result.providerName,
        model: result.model,
        assetIds: [],
        revisedPrompt: result.images.find((i) => i.revisedPrompt)?.revisedPrompt ?? null,
        usage: result.usage,
        error: null,
        durationMs: Date.now() - started
      }
      this.deps.generations.insert(stored, usageRecordId)
      for (const image of result.images) {
        try {
          assets.push(await this.deps.assets.saveGenerated(image.bytes, { prompt, generationId: stored.id, extensionHint: EXTENSION[result.outputFormat ?? input.format ?? 'png'] ?? 'png' }))
        } catch (error) {
          rejected.push(error instanceof Error ? error.message : 'unreadable image')
        }
      }
      if (!assets.length) {
        const unreadable = { kind: 'malformed' as const, message: 'The provider’s images could not be read as valid image files.', hint: rejected[0] ?? '' }
        this.deps.generations.markFailed(stored.id, unreadable)
        this.deps.log.warn('Provider returned images that could not be read', { count: result.images.length })
        return { ...stored, status: 'failed', assetIds: [], assets: [], error: unreadable }
      }
      this.deps.log.info(`Image generation succeeded (${assets.length} image(s))`, { size: input.size, provider: result.providerName })
      return { ...stored, assetIds: assets.map((a) => a.id), assets }
    } catch (error) {
      if (!(error instanceof AiServiceError)) throw error
      stored = {
        ...base,
        status: error.kind === 'cancelled' ? 'cancelled' : 'failed',
        providerId: config?.id ?? null,
        providerName: config?.name ?? (providerId ? 'Removed provider' : 'No provider'),
        model,
        assetIds: [],
        revisedPrompt: null,
        usage: null,
        error: { kind: error.kind, message: error.message, hint: error.hint },
        durationMs: Date.now() - started
      }
      this.deps.generations.insert(stored, null)
      assets = []
      return { ...stored, assets }
    }
  }

  history(limit = 30): ImageGenerationRecord[] {
    return this.deps.generations.list(limit).map((g) => ({ ...g, assets: this.deps.assets.byIds(g.assetIds) }))
  }

  get(id: string): ImageGenerationRecord {
    const g = this.deps.generations.get(id)
    if (!g) throw new NotFoundError('That image generation is no longer in the history.')
    return { ...g, assets: this.deps.assets.byIds(g.assetIds) }
  }

  /**
   * Optional: asks the text provider for a descriptive image prompt that
   * matches the post. The post text itself is never changed.
   */
  async suggestPrompt(input: ImagePromptRequest): Promise<ImagePromptOutcome> {
    const text = input.postText.trim()
    if (!text) throw new ValidationError('Write the post first — the prompt is based on its text.')
    if (!IMAGE_STYLES.includes(input.style)) throw new ValidationError('Choose one of the listed styles.')
    const instructions = [
      'You write prompts for an image generation model. The image will accompany a post on X.',
      'Describe one clear, concrete scene that illustrates the post’s subject for its intended audience and matches its tone.',
      'Only include subjects the post is actually about — no unrelated objects, people, mascots or logos.',
      'Do not ask for text, letters, captions or watermarks in the image. Do not name real people or brands unless the post does.',
      `Visual style: ${input.style}.`,
      'Reply with the prompt only: one paragraph, at most 80 words, no quotes or preamble.'
    ].join('\n')
    const extra = input.instructions.trim()
    try {
      const result = await this.deps.ai.generateText(
        {
          providerId: input.providerId,
          model: input.model,
          instructions,
          input: `Post:\n<<<\n${text}\n>>>${extra ? `\n\nExtra direction from the user:\n<<<\n${extra}\n>>>` : ''}`
        },
        { requestId: input.requestId }
      )
      const prompt = result.text.trim().replace(/^["“']+|["”']+$/g, '').trim()
      if (!prompt) return { ok: false, error: { kind: 'malformed', message: 'The model returned an empty prompt.', hint: 'Try again or write the prompt yourself.' } }
      return { ok: true, prompt: prompt.slice(0, 4000), providerName: result.providerName, model: result.model }
    } catch (error) {
      if (error instanceof AiServiceError) return { ok: false, error: { kind: error.kind, message: error.message, hint: error.hint } }
      throw error
    }
  }

  private safeProvider(id: string) {
    try {
      return this.deps.providers.get(id)
    } catch {
      return null
    }
  }
}
