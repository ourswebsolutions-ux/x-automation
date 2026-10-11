import { randomUUID } from 'node:crypto'
import { MAX_HASHTAGS, normalizeHashtag } from '@shared/config/postLimits'
import type { TextGenerationResult } from '@shared/types/ai'
import {
  LANGUAGES,
  TONES,
  type AssistRequest,
  type GenerationBrief,
  type GenerationHistoryQuery,
  type GenerationOperation,
  type GenerationRecord,
  type GenerationRunOptions
} from '@shared/types/generator'
import type { AiService } from '../ai/aiService'
import { AiServiceError } from '../ai/errors'
import type { GenerationRepository } from '../database/sqlite/generationRepository'
import { NotFoundError, ValidationError } from '../errors'
import type { ScopedLogger } from '../logging/logger'
import type { PreferencesStore } from '../preferences/preferencesStore'
import type { ProviderService } from '../providers/providerService'
import { MAX_DRAFT_CHARS } from '../drafts/draftService'
import { buildAssistPrompt, buildGenerationPrompt, type BuiltPrompt } from './prompts'
import { parseResults } from './parse'

interface Deps {
  ai: AiService
  providers: ProviderService
  preferences: PreferencesStore
  generations: GenerationRepository
  log: ScopedLogger
}

const LANGUAGE_PATTERN = /^[\p{L}][\p{L} ()'-]{1,39}$/u

function language(value: string | undefined): string {
  const lang = (value ?? '').trim()
  if ((LANGUAGES as readonly string[]).includes(lang) || LANGUAGE_PATTERN.test(lang)) return lang
  throw new ValidationError('Choose a language from the list, or type its name (letters only).')
}

function hashtags(values: string[]): string[] {
  const out = [...new Set(values.map((v) => normalizeHashtag(v)).filter((t): t is string => Boolean(t)))]
  if (out.length !== values.length && values.some((v) => !normalizeHashtag(v))) throw new ValidationError('Hashtags may use letters, numbers and underscores only.')
  if (out.length > MAX_HASHTAGS) throw new ValidationError(`Use at most ${MAX_HASHTAGS} hashtags.`)
  return out
}

/**
 * The tweet generator and AI editing tools, built on AiService. Every request
 * — successful or not — is written to the generation history with its
 * settings, results, provider, model and provider-reported usage. Failures are
 * returned as records with an error, never as made-up text.
 */
export class GeneratorService {
  constructor(private readonly deps: Deps) {}

  async generate(input: GenerationBrief, options: GenerationRunOptions): Promise<GenerationRecord> {
    const brief = this.validateBrief(input)
    return this.run('generate', buildGenerationPrompt(brief), brief, null, null, options)
  }

  async assist(input: AssistRequest, options: GenerationRunOptions): Promise<GenerationRecord> {
    const text = input.text.trim()
    if (!text) throw new ValidationError('There is no text to work on — write something first.')
    if (text.length > MAX_DRAFT_CHARS) throw new ValidationError('That draft is too long to send.')
    const request: AssistRequest = {
      ...input,
      text,
      hashtags: hashtags(input.hashtags),
      tone: input.tool === 'tone' ? (input.tone ?? 'professional') : undefined,
      language: input.tool === 'translate' ? language(input.language) : undefined,
      variations: input.tool === 'alternatives' ? Math.min(Math.max(input.variations ?? 3, 2), 5) : 1
    }
    if (request.tone && !TONES.includes(request.tone)) throw new ValidationError('Choose one of the listed tones.')
    const { text: _t, hashtags: _h, ...settings } = request
    return this.run(request.tool, buildAssistPrompt(request), settings, text, request.draftId, options)
  }

  history(query: GenerationHistoryQuery = {}): GenerationRecord[] {
    return this.deps.generations.list(query)
  }

  get(id: string): GenerationRecord {
    const record = this.deps.generations.get(id)
    if (!record) throw new NotFoundError('That generation is no longer in the history.')
    return record
  }

  private validateBrief(input: GenerationBrief): GenerationBrief {
    const brief: GenerationBrief = {
      ...input,
      topic: input.topic.trim(),
      keyPoints: input.keyPoints.trim(),
      audience: input.audience.trim(),
      callToAction: input.callToAction.trim(),
      instructions: input.instructions.trim(),
      language: language(input.language),
      hashtags: hashtags(input.hashtags).slice(0, 10)
    }
    if (brief.topic.length + brief.keyPoints.length < 3) throw new ValidationError('Describe a topic or the main message first.')
    if (!TONES.includes(brief.tone)) throw new ValidationError('Choose one of the listed tones.')
    if (!Number.isInteger(brief.variations) || brief.variations < 1 || brief.variations > 5) throw new ValidationError('Ask for 1 to 5 variations.')
    return brief
  }

  private provider(options: GenerationRunOptions): { id: string | null; name: string } {
    const id = options.providerId ?? this.deps.preferences.get().defaults.textProviderId
    if (!id) return { id: null, name: 'No provider' }
    try {
      const config = this.deps.providers.get(id)
      return { id: config.id, name: config.name }
    } catch {
      return { id: null, name: 'Removed provider' }
    }
  }

  private async run(
    operation: GenerationOperation,
    prompt: BuiltPrompt,
    settings: GenerationRecord['settings'],
    sourceText: string | null,
    draftId: string | null,
    options: GenerationRunOptions
  ): Promise<GenerationRecord> {
    const started = Date.now()
    const base = {
      id: randomUUID(),
      operation,
      settings,
      sourceText,
      draftId: draftId && this.draftExists(draftId) ? draftId : null,
      createdAt: new Date(started).toISOString()
    }
    let record: GenerationRecord
    let usageRecordId: string | null = null
    try {
      const result: TextGenerationResult = await this.deps.ai.generateText(
        { providerId: options.providerId, model: options.model, instructions: prompt.instructions, input: prompt.input },
        { requestId: options.requestId }
      )
      usageRecordId = result.usageRecordId
      const results = parseResults(result.text, prompt.key, prompt.expected)
      const common = {
        ...base,
        providerId: result.providerId,
        providerName: result.providerName,
        model: result.model,
        finishReason: result.finishReason,
        usage: result.usage,
        durationMs: Date.now() - started
      }
      record = results
        ? { ...common, status: 'succeeded', results, error: null }
        : {
            ...common,
            status: 'failed',
            results: [],
            error: {
              kind: 'malformed',
              message:
                result.finishReason === 'length'
                  ? 'The model stopped at its output limit before finishing.'
                  : 'The model’s answer was not in the expected format, so no results could be shown.',
              hint:
                result.finishReason === 'length'
                  ? 'Raise “Max output tokens” for this provider (or leave it empty), or ask for fewer variations.'
                  : 'Try again, or choose a different model.'
            }
          }
    } catch (error) {
      if (!(error instanceof AiServiceError)) throw error
      const provider = this.provider(options)
      record = {
        ...base,
        providerId: provider.id,
        providerName: provider.name,
        model: options.model ?? null,
        status: error.kind === 'cancelled' ? 'cancelled' : 'failed',
        results: [],
        finishReason: null,
        error: { kind: error.kind, message: error.message, hint: error.hint },
        usage: null,
        durationMs: Date.now() - started
      }
    }
    this.deps.generations.insert(record, usageRecordId)
    this.deps.log.info(`Generation "${operation}" ${record.status}`, {
      results: record.results.length,
      provider: record.providerName,
      error: record.error?.kind ?? null
    })
    return record
  }

  private draftExists(id: string): boolean {
    return this.deps.generations.draftExists(id)
  }
}
