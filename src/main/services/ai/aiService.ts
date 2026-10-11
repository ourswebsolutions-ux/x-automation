import { randomUUID } from 'node:crypto'
import { AI_ADAPTERS, TEST_PROMPT_MAX_CHARS, TEST_PROMPT_MAX_OUTPUT_TOKENS, type AiOperation } from '@shared/config/aiAdapters'
import { keyRequired, MODEL_PATTERN, validateEndpoint } from '@shared/config/providers'
import type {
  AiConnectionTest,
  AiModelList,
  AiOverview,
  AiUsageQuery,
  AiUsageRecord,
  AiUsageSummary,
  TestPromptInput,
  TextGenerationRequest,
  TextGenerationResult
} from '@shared/types/ai'
import type { ProviderConfig } from '@shared/types/providers'
import type { SettingsRepository } from '../database/repositories'
import type { AiUsageRepository } from '../database/sqlite/aiUsageRepository'
import { NotFoundError, ValidationError } from '../errors'
import type { ScopedLogger } from '../logging/logger'
import type { PreferencesStore } from '../preferences/preferencesStore'
import type { ProviderService } from '../providers/providerService'
import { AI_ADAPTER_IMPLEMENTATIONS } from './adapters/openai'
import type { AdapterContext, AdapterImageResult, AiAdapter } from './adapters/types'
import { createGuardedFetch, type LookupFn } from './endpointGuard'
import { AiServiceError, classifyError } from './errors'

interface Deps {
  providers: ProviderService
  preferences: PreferencesStore
  settings: SettingsRepository
  usage: AiUsageRepository
  log: ScopedLogger
  onChange: () => void
  /** Swappable for tests. */
  fetchImpl?: typeof fetch
  lookup?: LookupFn
}

type StoredTest = AiConnectionTest & { fingerprint: string }

const TEST_KEY = (id: string) => `ai.lastTest.${id}`
const MODELS_KEY = (id: string) => `ai.models.${id}`
const MAX_INPUT_CHARS = 32_000
const MAX_INSTRUCTION_CHARS = 8_000
const RETRYABLE = new Set(['network', 'timeout', 'server', 'rate-limit'])

/**
 * A test proves a key works against an endpoint, so it stays valid until one
 * of those (or the provider type) changes. Model changes don't invalidate it;
 * whether the model is listed is re-checked against the cached list.
 */
const fingerprint = (config: ProviderConfig) => `${config.adapter}|${config.endpoint}|${config.credential?.updatedAt ?? 'no-key'}|${config.enabled}`

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(timer), reject(new AiServiceError('cancelled', 'Request cancelled.'))), { once: true })
  })

/**
 * The AI layer. All provider traffic happens here, in the main process:
 * resolve a configuration, check it, call its adapter, normalise the result,
 * classify failures and record usage. The renderer never sees a key and can
 * only trigger the specific operations exposed over IPC.
 */
export class AiService {
  private readonly inFlight = new Map<string, { controller: AbortController; providerId: string; operation: AiOperation; startedAt: string }>()
  private readonly testsRunning = new Map<string, Promise<AiConnectionTest>>()

  constructor(private readonly deps: Deps) {}

  overview(): AiOverview {
    const tests: AiOverview['tests'] = {}
    for (const config of [...this.deps.providers.list('openai-compatible'), ...this.deps.providers.list('image')]) {
      const test = this.lastTest(config)
      if (test) tests[config.id] = test
    }
    return {
      tests,
      inFlight: [...this.inFlight.entries()].map(([requestId, r]) => ({ requestId, providerId: r.providerId, operation: r.operation, startedAt: r.startedAt }))
    }
  }

  /** Last test result, if it was made with the current settings and key. */
  lastTest(config: ProviderConfig): AiConnectionTest | null {
    const stored = this.deps.settings.get<StoredTest>(TEST_KEY(config.id))
    if (!stored || stored.fingerprint !== fingerprint(config)) return null
    const { fingerprint: _f, ...test } = stored
    if (!test.ok) return test
    const models = this.cachedModels(config.id)?.models
    return { ...test, modelListed: config.model && models ? models.some((m) => m.id === config.model) : null }
  }

  cachedModels(providerId: string): AiModelList | null {
    return this.deps.settings.get<AiModelList>(MODELS_KEY(providerId)) ?? null
  }

  /** A real GET /models with the saved key. Costs nothing and proves the key and endpoint work. */
  testConnection(providerId: string): Promise<AiConnectionTest> {
    const running = this.testsRunning.get(providerId)
    if (running) return running
    const promise = this.runTest(providerId).finally(() => this.testsRunning.delete(providerId))
    this.testsRunning.set(providerId, promise)
    return promise
  }

  private async runTest(providerId: string): Promise<AiConnectionTest> {
    const { config, adapter, apiKey } = this.resolve(providerId, { needModel: false })
    const started = Date.now()
    const startedAt = new Date(started).toISOString()
    let result: AiConnectionTest
    try {
      const models = await this.withRetries(config, (signal) => adapter.listModels(this.context(config, apiKey, signal)))
      const latencyMs = Date.now() - started
      this.deps.settings.set(MODELS_KEY(config.id), { providerId: config.id, fetchedAt: new Date().toISOString(), models } satisfies AiModelList)
      result = {
        ok: true,
        providerId: config.id,
        checkedAt: new Date().toISOString(),
        latencyMs,
        modelCount: models.length,
        modelListed: config.model ? models.some((m) => m.id === config.model) : null,
        error: null
      }
      this.record(config, 'connection-test', startedAt, started, { status: 'succeeded', model: config.model })
      this.deps.log.success(`Connection test passed for "${config.name}"`, { latencyMs, models: models.length, modelListed: result.modelListed })
    } catch (error) {
      const ai = classifyError(error, { operation: 'list-models' })
      result = { ok: false, providerId: config.id, checkedAt: new Date().toISOString(), latencyMs: null, modelCount: null, modelListed: null, error: ai.toJSON() }
      this.record(config, 'connection-test', startedAt, started, { status: ai.kind === 'cancelled' ? 'cancelled' : 'failed', model: config.model, errorKind: ai.kind })
      this.deps.log.warn(`Connection test failed for "${config.name}": ${ai.message}`, { kind: ai.kind, status: ai.status, code: ai.code })
    }
    this.deps.settings.set(TEST_KEY(config.id), { ...result, fingerprint: fingerprint(config) } satisfies StoredTest)
    this.deps.onChange()
    return result
  }

  /**
   * Models the key can use. Without `refresh` only the last fetched list is
   * returned (or null) — opening a settings dialog never triggers a request.
   */
  async listModels(providerId: string, refresh = false): Promise<AiModelList | null> {
    if (!refresh) return this.cachedModels(providerId)
    const { config, adapter, apiKey } = this.resolve(providerId, { needModel: false })
    const started = Date.now()
    try {
      const models = await this.withRetries(config, (signal) => adapter.listModels(this.context(config, apiKey, signal)))
      const list: AiModelList = { providerId, fetchedAt: new Date().toISOString(), models }
      this.deps.settings.set(MODELS_KEY(providerId), list)
      this.record(config, 'list-models', new Date(started).toISOString(), started, { status: 'succeeded', model: null })
      return list
    } catch (error) {
      const ai = classifyError(error, { operation: 'list-models' })
      this.record(config, 'list-models', new Date(started).toISOString(), started, { status: ai.kind === 'cancelled' ? 'cancelled' : 'failed', model: null, errorKind: ai.kind })
      this.deps.log.warn(`Could not list models for "${config.name}": ${ai.message}`, { kind: ai.kind, status: ai.status })
      throw ai
    }
  }

  /**
   * Generates text with a configured provider. This is the entry point later
   * features (the tweet generator, rewriting, replies) build on. Not retried:
   * generation is not idempotent and is billed.
   */
  async generateText(request: TextGenerationRequest, options: { signal?: AbortSignal; requestId?: string } = {}): Promise<TextGenerationResult> {
    const input = request.input?.trim() ?? ''
    if (!input) throw new ValidationError('There is nothing to send — the prompt is empty.')
    if (input.length > MAX_INPUT_CHARS) throw new ValidationError(`Prompts can be up to ${MAX_INPUT_CHARS.toLocaleString()} characters.`)
    const instructions = request.instructions?.trim() || null
    if (instructions && instructions.length > MAX_INSTRUCTION_CHARS) throw new ValidationError('The instructions are too long.')

    const { config, adapter, apiKey } = this.resolve(request.providerId, { needModel: !request.model, kind: 'openai-compatible' })
    this.checkLimits(config.id)
    const generate = adapter.generateText
    if (!generate) throw new AiServiceError('not-configured', `“${config.name}” cannot generate text.`, 'Choose an AI text provider.')
    const model = (request.model ?? config.model ?? '').trim()
    if (!MODEL_PATTERN.test(model)) throw new ValidationError('That model name is not valid.')
    const defaults = config.settings.generation ?? { temperature: null, maxOutputTokens: null }
    const temperature = request.temperature !== undefined ? request.temperature : defaults.temperature
    const maxOutputTokens = request.maxOutputTokens !== undefined ? request.maxOutputTokens : defaults.maxOutputTokens
    const limits = adapter.meta.parameters
    if (temperature !== null && (temperature < limits.temperature.min || temperature > limits.temperature.max)) {
      throw new ValidationError(`Temperature must be between ${limits.temperature.min} and ${limits.temperature.max}.`)
    }
    if (maxOutputTokens !== null && (!Number.isInteger(maxOutputTokens) || maxOutputTokens < limits.maxOutputTokens.min || maxOutputTokens > limits.maxOutputTokens.max)) {
      throw new ValidationError(`Maximum output tokens must be between ${limits.maxOutputTokens.min} and ${limits.maxOutputTokens.max}.`)
    }

    const requestId = options.requestId ?? randomUUID()
    if (this.inFlight.has(requestId)) throw new ValidationError('A request with that id is already running.')
    const controller = new AbortController()
    if (options.signal) {
      if (options.signal.aborted) controller.abort()
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    const started = Date.now()
    const startedAt = new Date(started).toISOString()
    this.inFlight.set(requestId, { controller, providerId: config.id, operation: 'generate-text', startedAt })
    this.deps.onChange()

    try {
      const result = await generate(this.context(config, apiKey, controller.signal), {
        model,
        instructions,
        input,
        temperature,
        maxOutputTokens
      })
      const latencyMs = Date.now() - started
      const usageRecordId = this.record(config, 'generate-text', startedAt, started, {
        status: 'succeeded',
        model: result.model,
        usage: result.usage,
        providerRequestId: result.providerRequestId
      })
      this.deps.log.success(`Generated text with "${config.name}" (${result.model})`, {
        latencyMs,
        finish: result.finishReason,
        inputTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null
      })
      return { ...result, providerId: config.id, providerName: config.name, adapter: adapter.id, latencyMs, usageRecordId }
    } catch (error) {
      const ai = controller.signal.aborted ? new AiServiceError('cancelled', 'Request cancelled.') : classifyError(error, { operation: 'generate-text', model })
      this.record(config, 'generate-text', startedAt, started, { status: ai.kind === 'cancelled' ? 'cancelled' : 'failed', model, errorKind: ai.kind })
      if (ai.kind === 'cancelled') this.deps.log.info(`Generation with "${config.name}" cancelled`)
      else this.deps.log.warn(`Generation with "${config.name}" failed: ${ai.message}`, { kind: ai.kind, status: ai.status, code: ai.code })
      throw ai
    } finally {
      this.inFlight.delete(requestId)
      this.deps.onChange()
    }
  }

  /**
   * Generates images with an image provider. Like text generation it is
   * billed and never retried automatically. Parameters must already be
   * validated against the model's capabilities (ImageService does that).
   */
  async generateImages(
    request: { providerId?: string; model?: string; prompt: string; size: string; quality: string | null; format: 'png' | 'jpeg' | 'webp' | null; transparent: boolean; n: number; requestBase64: boolean },
    options: { requestId?: string } = {}
  ): Promise<AdapterImageResult & { providerId: string; providerName: string; latencyMs: number; usageRecordId: string }> {
    const { config, adapter, apiKey } = this.resolve(request.providerId, { needModel: !request.model, kind: 'image' })
    this.checkLimits(config.id)
    const generate = adapter.generateImages
    if (!generate) throw new AiServiceError('not-configured', `“${config.name}” cannot generate images.`)
    const model = (request.model ?? config.model ?? '').trim()
    if (!MODEL_PATTERN.test(model)) throw new ValidationError('That model name is not valid.')
    const requestId = options.requestId ?? randomUUID()
    if (this.inFlight.has(requestId)) throw new ValidationError('A request with that id is already running.')
    const controller = new AbortController()
    const started = Date.now()
    const startedAt = new Date(started).toISOString()
    this.inFlight.set(requestId, { controller, providerId: config.id, operation: 'generate-image', startedAt })
    this.deps.onChange()
    const imageMeta = { imageSize: request.size, imageFormat: request.format, imageQuality: request.quality }
    try {
      const ctx = { ...this.context(config, apiKey, controller.signal), fetchForDownloads: this.deps.fetchImpl }
      const result = await generate(ctx, { ...request, model })
      const latencyMs = Date.now() - started
      const usageRecordId = this.record(config, 'generate-image', startedAt, started, {
        status: 'succeeded',
        model,
        usage: result.usage,
        providerRequestId: result.providerRequestId,
        imageCount: result.images.length,
        ...imageMeta,
        imageSize: result.size ?? request.size,
        imageFormat: result.outputFormat ?? request.format
      })
      this.deps.log.success(`Generated ${result.images.length} image(s) with "${config.name}" (${model})`, { latencyMs, size: request.size, tokens: result.usage?.totalTokens ?? null })
      return { ...result, providerId: config.id, providerName: config.name, latencyMs, usageRecordId }
    } catch (error) {
      const ai = controller.signal.aborted ? new AiServiceError('cancelled', 'Request cancelled.') : classifyError(error, { operation: 'generate-text', model })
      this.record(config, 'generate-image', startedAt, started, { status: ai.kind === 'cancelled' ? 'cancelled' : 'failed', model, errorKind: ai.kind, ...imageMeta })
      if (ai.kind === 'cancelled') this.deps.log.info(`Image generation with "${config.name}" cancelled`)
      else this.deps.log.warn(`Image generation with "${config.name}" failed: ${ai.message}`, { kind: ai.kind, status: ai.status, code: ai.code })
      throw ai
    } finally {
      this.inFlight.delete(requestId)
      this.deps.onChange()
    }
  }

  /** The settings page's "Try a prompt": short prompt, small output cap, cancellable. */
  async testPrompt(input: TestPromptInput): Promise<TextGenerationResult> {
    const prompt = input.prompt.trim()
    if (prompt.length > TEST_PROMPT_MAX_CHARS) throw new ValidationError(`Test prompts can be up to ${TEST_PROMPT_MAX_CHARS} characters.`)
    const config = this.deps.providers.get(input.providerId)
    const configured = config.settings.generation?.maxOutputTokens ?? null
    const adapterMin = config.adapter ? AI_ADAPTERS[config.adapter].parameters.maxOutputTokens.min : 1
    const cap = Math.max(adapterMin, Math.min(configured ?? TEST_PROMPT_MAX_OUTPUT_TOKENS, TEST_PROMPT_MAX_OUTPUT_TOKENS))
    return this.generateText({ providerId: input.providerId, model: input.model, input: prompt, maxOutputTokens: cap }, { requestId: input.requestId })
  }

  cancel(requestId: string): boolean {
    const entry = this.inFlight.get(requestId)
    if (!entry) return false
    entry.controller.abort()
    return true
  }

  usage(query: AiUsageQuery): AiUsageRecord[] {
    return this.deps.usage.query(query)
  }

  usageSummary(query: AiUsageQuery): AiUsageSummary {
    return this.deps.usage.summary(query)
  }

  // ── internals ────────────────────────────────────────────────────────────

  private resolve(
    providerId: string | undefined,
    { needModel, kind }: { needModel: boolean; kind?: 'openai-compatible' | 'image' }
  ): { config: ProviderConfig; adapter: AiAdapter; apiKey: string | null } {
    const defaults = this.deps.preferences.get().defaults
    const id = providerId ?? (kind === 'image' ? defaults.imageProviderId : defaults.textProviderId)
    if (!id) {
      throw kind === 'image'
        ? new AiServiceError('not-configured', 'No image provider is selected.', 'Choose a default image provider in Settings → Image generation.')
        : new AiServiceError('not-configured', 'No AI text provider is selected.', 'Choose a default text provider in Settings → AI providers.')
    }
    let config: ProviderConfig
    try {
      config = this.deps.providers.get(id)
    } catch (error) {
      if (error instanceof NotFoundError) throw new AiServiceError('not-configured', 'That AI provider no longer exists.', 'Choose another provider in Settings → AI providers.')
      throw error
    }
    if ((config.kind !== 'openai-compatible' && config.kind !== 'image') || !config.adapter || (kind && config.kind !== kind)) {
      throw new AiServiceError('not-configured', kind === 'image' ? 'That configuration is not an image provider.' : 'That configuration is not an AI text provider.')
    }
    if (!config.enabled) throw new AiServiceError('not-configured', `“${config.name}” is disabled.`, 'Enable it in Settings → AI providers.')
    const endpointProblem = validateEndpoint(config.kind, config.endpoint)
    if (endpointProblem) throw new AiServiceError('not-configured', endpointProblem, 'Fix the endpoint in Settings → AI providers.')
    const where = config.kind === 'image' ? 'Settings → Image generation' : 'Settings → AI providers'
    if (needModel && !config.model) throw new AiServiceError('not-configured', `No model is selected for “${config.name}”.`, `Choose a model in ${where}.`)
    const apiKey = this.deps.providers.secretFor(id)
    if (!apiKey && config.credential) {
      throw new AiServiceError('not-configured', `The stored key for “${config.name}” cannot be read on this device.`, 'Enter the key again in Settings → AI providers.')
    }
    if (!apiKey && keyRequired(config.kind, config.endpoint)) {
      throw new AiServiceError('not-configured', `“${config.name}” has no API key.`, 'Add the key in Settings → AI providers.')
    }
    return { config, adapter: AI_ADAPTER_IMPLEMENTATIONS[config.adapter], apiKey }
  }

  private context(config: ProviderConfig, apiKey: string | null, signal?: AbortSignal): AdapterContext {
    return {
      endpoint: config.endpoint,
      apiKey,
      timeoutMs: config.settings.timeoutMs,
      fetch: createGuardedFetch(config.endpoint, { fetchImpl: this.deps.fetchImpl, lookup: this.deps.lookup }),
      signal
    }
  }

  /** Retries safe, read-only requests on transient failures, with backoff. */
  private async withRetries<T>(config: ProviderConfig, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    let attempt = 0
    for (;;) {
      try {
        return await run(controller.signal)
      } catch (error) {
        const ai = classifyError(error, { operation: 'list-models' })
        if (attempt >= config.settings.retries || !RETRYABLE.has(ai.kind)) throw ai
        const wait = ai.retryAfterSec !== null ? Math.min(ai.retryAfterSec * 1000, 10_000) : 400 * 2 ** attempt
        attempt++
        await sleep(wait, controller.signal)
      }
    }
  }

  private guard: { blockedReason(providerId: string): string | null; evaluate(providerId: string): void } | null = null

  /** Usage limits (Settings → Usage & costs): checked before generation, evaluated after every request. */
  setUsageGuard(guard: { blockedReason(providerId: string): string | null; evaluate(providerId: string): void }): void {
    this.guard = guard
  }

  private checkLimits(providerId: string): void {
    const reason = this.guard?.blockedReason(providerId)
    if (reason) throw new AiServiceError('usage-limit', reason, 'Raise or remove the limit in Settings → Usage & costs.')
  }

  private record(
    config: ProviderConfig,
    operation: AiOperation,
    startedAt: string,
    started: number,
    outcome: Pick<AiUsageRecord, 'status' | 'model'> &
      Partial<Pick<AiUsageRecord, 'errorKind' | 'usage' | 'providerRequestId' | 'imageCount' | 'imageSize' | 'imageFormat' | 'imageQuality'>>
  ): string {
    const id = randomUUID()
    try {
      this.deps.usage.insert({
        id,
        providerId: config.id,
        providerName: config.name,
        adapter: config.adapter!,
        model: outcome.model,
        operation,
        status: outcome.status,
        errorKind: outcome.errorKind ?? null,
        startedAt,
        durationMs: Date.now() - started,
        usage: outcome.usage ?? null,
        imageCount: outcome.imageCount ?? null,
        imageSize: outcome.imageSize ?? null,
        imageFormat: outcome.imageFormat ?? null,
        imageQuality: outcome.imageQuality ?? null,
        estimatedCostUsd: null,
        providerRequestId: outcome.providerRequestId ?? null
      })
    } catch (error) {
      // Usage history must never break the request itself.
      this.deps.log.error('Could not record AI usage', error)
    }
    this.guard?.evaluate(config.id)
    return id
  }
}
