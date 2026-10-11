import OpenAI from 'openai'
import { AI_ADAPTERS, isLikelyTextModel } from '@shared/config/aiAdapters'
import type { AiTokenUsage, FinishReason } from '@shared/types/ai'
import { AiServiceError } from '../errors'
import { fetchPublicImage } from '../endpointGuard'
import type { AdapterContext, AdapterImageRequest, AdapterImageResult, AdapterTextRequest, AdapterTextResult, AiAdapter } from './types'

const MAX_MODELS = 2000

/**
 * SDK client for one request. Every option the SDK would otherwise read from
 * environment variables is set explicitly, so nothing from the machine's
 * environment (keys, base URLs, organisation, logging) leaks in. Retries are
 * off: generation is not idempotent and costs money; AiService retries safe
 * reads itself.
 */
function client(ctx: AdapterContext): OpenAI {
  return new OpenAI({
    apiKey: ctx.apiKey ?? 'not-required',
    adminAPIKey: null,
    organization: null,
    project: null,
    webhookSecret: null,
    baseURL: ctx.endpoint,
    timeout: ctx.timeoutMs,
    maxRetries: 0,
    fetch: ctx.fetch,
    logLevel: 'off'
  })
}

const count = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null)

function usageOf(input: unknown, output: unknown, total: unknown): AiTokenUsage | null {
  const usage = { inputTokens: count(input), outputTokens: count(output), totalTokens: count(total) }
  return usage.inputTokens === null && usage.outputTokens === null && usage.totalTokens === null ? null : usage
}

const requestIdOf = (value: unknown) => {
  const id = (value as { _request_id?: unknown })._request_id
  return typeof id === 'string' ? id.slice(0, 120) : null
}

async function listModels(ctx: AdapterContext) {
  const models = []
  for await (const model of client(ctx).models.list({ signal: ctx.signal })) {
    if (typeof model?.id !== 'string' || !model.id) throw new AiServiceError('malformed', 'The model list was not in the expected format.')
    models.push({ id: model.id.slice(0, 200), ownedBy: typeof model.owned_by === 'string' ? model.owned_by : null, likelyText: isLikelyTextModel(model.id) })
    if (models.length >= MAX_MODELS) break
  }
  return models.sort((a, b) => a.id.localeCompare(b.id))
}

/** OpenAI's Responses API. `store: false` keeps prompts out of OpenAI's stored responses. */
export const openAiResponsesAdapter: AiAdapter = {
  id: 'openai',
  meta: AI_ADAPTERS.openai,
  listModels,
  async generateText(ctx: AdapterContext, req: AdapterTextRequest): Promise<AdapterTextResult> {
    const response = await client(ctx).responses.create(
      {
        model: req.model,
        input: req.input,
        ...(req.instructions ? { instructions: req.instructions } : {}),
        ...(req.temperature !== null ? { temperature: req.temperature } : {}),
        ...(req.maxOutputTokens !== null ? { max_output_tokens: req.maxOutputTokens } : {}),
        store: false
      },
      { signal: ctx.signal }
    )
    if (!response || typeof response !== 'object' || typeof response.status !== 'string') {
      throw new AiServiceError('malformed', 'The provider’s response was not in the expected format.')
    }
    if (response.status === 'failed') {
      throw new AiServiceError('server', 'The provider could not complete the response.', response.error?.message?.slice(0, 200) ?? '')
    }
    const reason = response.incomplete_details?.reason
    const finishReason: FinishReason =
      response.status === 'completed' ? 'stop' : reason === 'max_output_tokens' ? 'length' : reason === 'content_filter' ? 'content-filter' : 'other'
    const text = typeof response.output_text === 'string' ? response.output_text : ''
    return {
      text,
      model: typeof response.model === 'string' ? response.model : req.model,
      finishReason,
      usage: usageOf(response.usage?.input_tokens, response.usage?.output_tokens, response.usage?.total_tokens),
      providerRequestId: requestIdOf(response)
    }
  }
}

const FINISH: Record<string, FinishReason> = { stop: 'stop', length: 'length', content_filter: 'content-filter' }

/** Chat Completions — the API most OpenAI-compatible services implement. */
export const openAiChatAdapter: AiAdapter = {
  id: 'openai-chat',
  meta: AI_ADAPTERS['openai-chat'],
  listModels,
  async generateText(ctx: AdapterContext, req: AdapterTextRequest): Promise<AdapterTextResult> {
    const completion = await client(ctx).chat.completions.create(
      {
        model: req.model,
        messages: [...(req.instructions ? [{ role: 'system' as const, content: req.instructions }] : []), { role: 'user' as const, content: req.input }],
        ...(req.temperature !== null ? { temperature: req.temperature } : {}),
        ...(req.maxOutputTokens !== null ? { max_tokens: req.maxOutputTokens } : {})
      },
      { signal: ctx.signal }
    )
    const choice = Array.isArray(completion?.choices) ? completion.choices[0] : undefined
    const content = choice?.message?.content
    if (!choice || (content !== null && typeof content !== 'string')) {
      throw new AiServiceError('malformed', 'The provider’s response had no message.', 'Check that the endpoint implements Chat Completions.')
    }
    return {
      text: content ?? '',
      model: typeof completion.model === 'string' && completion.model ? completion.model : req.model,
      finishReason: FINISH[choice.finish_reason ?? ''] ?? 'other',
      usage: usageOf(completion.usage?.prompt_tokens, completion.usage?.completion_tokens, completion.usage?.total_tokens),
      providerRequestId: requestIdOf(completion)
    }
  }
}

const MAX_IMAGE_BYTES = 25 * 1024 * 1024

/**
 * OpenAI's Images API (POST /images/generations), or a service exposing it.
 * Parameters are sent only when the model supports them (see
 * shared/config/imageModels.ts). Images arrive as base64, or — for dall-e
 * models without base64 — as short-lived URLs fetched from public https hosts.
 */
export const openAiImagesAdapter: AiAdapter = {
  id: 'openai-images',
  meta: AI_ADAPTERS['openai-images'],
  listModels,
  async generateImages(ctx: AdapterContext, req: AdapterImageRequest): Promise<AdapterImageResult> {
    const response = await client(ctx).images.generate(
      {
        model: req.model,
        prompt: req.prompt,
        n: req.n,
        size: req.size as never,
        ...(req.quality ? { quality: req.quality as never } : {}),
        ...(req.format ? { output_format: req.format } : {}),
        ...(req.transparent ? { background: 'transparent' as const } : {}),
        ...(req.requestBase64 ? { response_format: 'b64_json' as const } : {})
      },
      { signal: ctx.signal }
    )
    const data = Array.isArray(response?.data) ? response.data : null
    if (!data || data.length === 0) throw new AiServiceError('malformed', 'The provider returned no images.', 'The prompt may have been refused, or the model does not support this request.')
    const images: AdapterImageResult['images'] = []
    for (const item of data) {
      let bytes: Buffer
      if (typeof item.b64_json === 'string' && item.b64_json) {
        if (item.b64_json.length * 0.75 > MAX_IMAGE_BYTES) throw new AiServiceError('malformed', 'The returned image is unexpectedly large.')
        bytes = Buffer.from(item.b64_json, 'base64')
      } else if (typeof item.url === 'string' && item.url) {
        bytes = await fetchPublicImage(item.url, { fetchImpl: ctx.fetchForDownloads, signal: ctx.signal, maxBytes: MAX_IMAGE_BYTES, timeoutMs: ctx.timeoutMs })
      } else {
        throw new AiServiceError('malformed', 'An image in the response had no data.')
      }
      images.push({ bytes, revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt.slice(0, 4000) : null })
    }
    return {
      images,
      model: req.model,
      usage: usageOf(response.usage?.input_tokens, response.usage?.output_tokens, response.usage?.total_tokens),
      providerRequestId: requestIdOf(response),
      outputFormat: typeof response.output_format === 'string' ? response.output_format : null,
      size: typeof response.size === 'string' ? response.size : null
    }
  }
}

export const AI_ADAPTER_IMPLEMENTATIONS: Record<AiAdapter['id'], AiAdapter> = {
  openai: openAiResponsesAdapter,
  'openai-chat': openAiChatAdapter,
  'openai-images': openAiImagesAdapter
}
