import { randomUUID } from 'node:crypto'
import { keyRequired, PROVIDER_KINDS, validateEndpoint, validateModel, validateProviderName } from '@shared/config/providers'
import type { Id } from '@shared/types/domain'
import { AI_ADAPTERS, isAiAdapterId } from '@shared/config/aiAdapters'
import {
  DEFAULT_AI_SETTINGS,
  DEFAULT_IMAGE_SETTINGS,
  DEFAULT_PROVIDER_SETTINGS,
  type ProviderConfig,
  type ProviderInput,
  type ProviderKind,
  type ProviderReadiness
} from '@shared/types/providers'
import type { CredentialVault } from '../credentials/credentialVault'
import { CredentialUnavailableError } from '../credentials/credentialVault'
import type { SqliteDatabase } from '../database/driver'
import type { CredentialRefRepository, ProviderRecord, ProviderRepository } from '../database/repositories'
import { ValidationError, NotFoundError, ConflictError } from '../errors'
import type { ScopedLogger } from '../logging/logger'
import type { PreferencesStore } from '../preferences/preferencesStore'

interface Deps {
  db: SqliteDatabase
  providers: ProviderRepository
  credentialRefs: CredentialRefRepository
  vault: CredentialVault
  preferences: PreferencesStore
  log: ScopedLogger
  onChange: () => void
}

const vaultKeyFor = (providerId: Id) => `provider:${providerId}`

/** Shows the last four characters only for keys long enough that this reveals little. */
const hintFor = (secret: string) => (secret.length >= 16 ? secret.slice(-4) : null)

/**
 * Manages provider configurations and their write-only API keys.
 *
 * "Ready" means the configuration is complete enough to test — it does not
 * mean a connection works. Real connection tests ship with each integration.
 */
export class ProviderService {
  constructor(private readonly deps: Deps) {}

  list(kind?: ProviderKind): ProviderConfig[] {
    return this.deps.providers.list(kind).map((record) => this.toView(record))
  }

  get(id: Id): ProviderConfig {
    const record = this.deps.providers.get(id)
    if (!record) throw new NotFoundError('That provider configuration no longer exists.')
    return this.toView(record)
  }

  create(input: ProviderInput): ProviderConfig {
    const clean = this.validate(input)
    this.assertUniqueName(clean.kind, clean.name)
    const at = new Date().toISOString()
    const record: ProviderRecord = { id: randomUUID(), ...clean, createdAt: at, updatedAt: at }
    this.deps.providers.insert(record)
    this.deps.log.info(`Added ${PROVIDER_KINDS[record.kind].label} configuration "${record.name}"`, { kind: record.kind })
    this.deps.onChange()
    return this.toView(record)
  }

  update(id: Id, input: ProviderInput): ProviderConfig {
    const existing = this.deps.providers.get(id)
    if (!existing) throw new NotFoundError('That provider configuration no longer exists.')
    if (existing.kind !== input.kind) throw new ValidationError('The provider type cannot be changed after creation.')
    // Toggles and older callers may omit the adapter; it cannot change after creation either.
    if (input.adapter !== undefined && input.adapter !== existing.adapter) {
      throw new ValidationError('The provider type cannot be changed after creation.')
    }
    const clean = this.validate({ ...input, adapter: existing.adapter })
    this.assertUniqueName(clean.kind, clean.name, id)
    // Callers that omit settings (e.g. the enable toggle) keep the stored values.
    const record: ProviderRecord = {
      ...existing,
      ...clean,
      settings: input.settings ? clean.settings : existing.settings,
      updatedAt: new Date().toISOString()
    }
    this.deps.providers.update(record)
    if (!record.enabled) this.clearDefaultIfPointsTo(id)
    this.deps.log.info(`Updated configuration "${record.name}"`, { kind: record.kind, enabled: record.enabled })
    this.deps.onChange()
    return this.toView(record)
  }

  async remove(id: Id): Promise<void> {
    const existing = this.deps.providers.get(id)
    if (!existing) return
    const ref = this.deps.credentialRefs.forProvider(id)
    // credential_refs rows cascade with the provider row.
    this.deps.db.transaction(() => this.deps.providers.remove(id))
    if (ref) await this.deps.vault.delete(ref.vaultKey)
    this.clearDefaultIfPointsTo(id)
    this.deps.log.info(`Removed configuration "${existing.name}"`, { kind: existing.kind, hadKey: Boolean(ref) })
    this.deps.onChange()
  }

  async setKey(id: Id, secret: string): Promise<ProviderConfig> {
    const record = this.deps.providers.get(id)
    if (!record) throw new NotFoundError('That provider configuration no longer exists.')
    const value = secret.trim()
    if (value.length < 8) throw new ValidationError('That key looks too short.')
    if (value.length > 4096) throw new ValidationError('That key is too long.')
    if (/\s/.test(value)) throw new ValidationError('Keys cannot contain spaces or line breaks.')
    if (!this.deps.vault.status().secure) {
      throw new CredentialUnavailableError('Secure credential storage is not available on this system, so the key was not saved.')
    }

    const vaultKey = vaultKeyFor(id)
    await this.deps.vault.set(vaultKey, value)
    const at = new Date().toISOString()
    const existing = this.deps.credentialRefs.forProvider(id)
    this.deps.credentialRefs.upsert({
      id: existing?.id ?? randomUUID(),
      providerId: id,
      vaultKey,
      hint: hintFor(value),
      createdAt: existing?.createdAt ?? at,
      updatedAt: at
    })
    this.deps.log.info(`${existing ? 'Replaced' : 'Stored'} API key for "${record.name}"`, { kind: record.kind })
    this.deps.onChange()
    return this.toView(record)
  }

  async removeKey(id: Id): Promise<ProviderConfig> {
    const record = this.deps.providers.get(id)
    if (!record) throw new NotFoundError('That provider configuration no longer exists.')
    const ref = this.deps.credentialRefs.forProvider(id)
    if (ref) {
      this.deps.credentialRefs.removeForProvider(id)
      await this.deps.vault.delete(ref.vaultKey)
      this.deps.log.info(`Removed API key for "${record.name}"`, { kind: record.kind })
      this.deps.onChange()
    }
    return this.toView(record)
  }

  /** Removes every stored key and its reference. Configurations are kept. */
  async clearAllKeys(): Promise<number> {
    const refs = this.deps.credentialRefs.clear()
    const vaultEntries = await this.deps.vault.clear()
    this.deps.log.warn('Removed all stored API keys', { references: refs, vaultEntries })
    this.deps.onChange()
    return Math.max(refs, vaultEntries)
  }

  /** Main-process only: the decrypted key for an integration. Never sent over IPC. */
  secretFor(id: Id): string | null {
    const ref = this.deps.credentialRefs.forProvider(id)
    return ref ? this.deps.vault.get(ref.vaultKey) : null
  }

  private validate(input: ProviderInput): Omit<ProviderRecord, 'id' | 'createdAt' | 'updatedAt'> {
    const problems = [
      validateProviderName(input.name),
      validateEndpoint(input.kind, input.endpoint),
      input.model?.trim() ? validateModel(input.kind, input.model) : null
    ].filter((p): p is string => p !== null)
    if (problems.length) throw new ValidationError(problems.join(' '))
    const ai = input.kind === 'openai-compatible'
    const image = input.kind === 'image'
    if (ai && (!isAiAdapterId(input.adapter) || !AI_ADAPTERS[input.adapter].capabilities.textGeneration)) {
      throw new ValidationError('Choose a provider type: OpenAI or OpenAI-compatible.')
    }
    if (image && input.adapter && input.adapter !== 'openai-images') throw new ValidationError('Image providers use the Images API type.')
    const base = ai ? DEFAULT_AI_SETTINGS : image ? DEFAULT_IMAGE_SETTINGS : DEFAULT_PROVIDER_SETTINGS
    const settings = { ...base, ...input.settings }
    if (ai) {
      const limits = AI_ADAPTERS[input.adapter!].parameters
      const generation = { ...DEFAULT_AI_SETTINGS.generation!, ...input.settings?.generation }
      const { temperature: t, maxOutputTokens: m } = generation
      if (t !== null && (typeof t !== 'number' || t < limits.temperature.min || t > limits.temperature.max)) {
        throw new ValidationError(`Temperature must be between ${limits.temperature.min} and ${limits.temperature.max}.`)
      }
      if (m !== null && (!Number.isInteger(m) || m < limits.maxOutputTokens.min || m > limits.maxOutputTokens.max)) {
        throw new ValidationError(`Maximum output tokens must be between ${limits.maxOutputTokens.min} and ${limits.maxOutputTokens.max}.`)
      }
      settings.generation = generation
    } else {
      delete settings.generation
    }
    if (image) {
      const defaults = { ...DEFAULT_IMAGE_SETTINGS.image!, ...input.settings?.image }
      if (!/^(auto|\d{2,4}x\d{2,4})$/.test(defaults.size)) throw new ValidationError('Choose an image size.')
      if (defaults.quality !== null && !/^[a-z]{2,10}$/.test(defaults.quality)) throw new ValidationError('Choose an image quality.')
      if (defaults.format !== null && !['png', 'jpeg', 'webp'].includes(defaults.format)) throw new ValidationError('Choose PNG, JPEG or WEBP.')
      settings.image = defaults
    } else {
      delete settings.image
    }
    if (!Number.isInteger(settings.timeoutMs) || settings.timeoutMs < 1000 || settings.timeoutMs > 120_000) {
      throw new ValidationError('Timeout must be between 1 and 120 seconds.')
    }
    if (!Number.isInteger(settings.retries) || settings.retries < 0 || settings.retries > 5) {
      throw new ValidationError('Retries must be between 0 and 5.')
    }
    return {
      kind: input.kind,
      adapter: ai ? input.adapter! : image ? 'openai-images' : null,
      name: input.name.trim(),
      endpoint: input.endpoint.trim().replace(/\/+$/, ''),
      model: input.model?.trim() || null,
      enabled: input.enabled,
      settings
    }
  }

  private assertUniqueName(kind: ProviderKind, name: string, exceptId?: Id): void {
    const clash = this.deps.providers.list(kind).some((p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase())
    if (clash) throw new ConflictError(`A ${PROVIDER_KINDS[kind].label} configuration named "${name}" already exists.`)
  }

  private clearDefaultIfPointsTo(id: Id): void {
    const { defaults } = this.deps.preferences.get()
    if (defaults.textProviderId === id) this.deps.preferences.update({ defaults: { textProviderId: null } })
    if (defaults.imageProviderId === id) this.deps.preferences.update({ defaults: { imageProviderId: null } })
  }

  private toView(record: ProviderRecord): ProviderConfig {
    const ref = this.deps.credentialRefs.forProvider(record.id)
    const credential = ref ? { hint: ref.hint, updatedAt: ref.updatedAt, present: this.deps.vault.has(ref.vaultKey) } : null
    return { ...record, credential, readiness: this.readiness(record, credential?.present ?? null) }
  }

  private readiness(record: ProviderRecord, keyPresent: boolean | null): ProviderReadiness {
    if (!record.enabled) return { state: 'disabled', issues: [] }
    const issues = [validateEndpoint(record.kind, record.endpoint), validateModel(record.kind, record.model)].filter(
      (p): p is string => p !== null
    )
    if (keyRequired(record.kind, record.endpoint) && keyPresent === null) issues.push('Add an API key.')
    if (keyPresent === false) issues.push('The stored key is missing on this device — enter it again.')
    return { state: issues.length ? 'incomplete' : 'ready', issues }
  }
}
