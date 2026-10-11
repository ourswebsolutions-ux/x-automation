import { PHASE } from '@shared/config/roadmap'
import type { IntegrationId, IntegrationStatus } from '@shared/types/integrations'
import type { ProviderConfig } from '@shared/types/providers'
import type { CredentialVault } from '../credentials/credentialVault'
import type { AiService } from '../ai/aiService'
import type { DatabaseService } from '../database/databaseService'
import type { PreferencesStore } from '../preferences/preferencesStore'
import type { ProviderService } from '../providers/providerService'
import type { IxBrowserService } from './ixbrowser/ixBrowserService'

interface Deps {
  providers: ProviderService
  vault: CredentialVault
  database: DatabaseService
  ixBrowser: IxBrowserService
  ai: AiService
  preferences: PreferencesStore
}

/**
 * Configuration-derived status. "configured" means settings are complete —
 * no integration reports "connected" until it has made a real request.
 */
function configStatus(id: IntegrationId, name: string, phase: number, feature: string, configs: ProviderConfig[]): IntegrationStatus {
  const ready = configs.filter((c) => c.readiness.state === 'ready')
  if (configs.length === 0) {
    return { id, name, phase, state: 'not-configured', detail: `No configuration yet. ${feature} arrives in Phase ${phase}.` }
  }
  if (ready.length === 0) {
    const enabled = configs.some((c) => c.enabled)
    return {
      id,
      name,
      phase,
      state: 'not-configured',
      detail: enabled ? 'Configuration incomplete — see Settings.' : 'All configurations are disabled.'
    }
  }
  return {
    id,
    name,
    phase,
    state: 'configured',
    detail: `"${ready[0]!.name}" is ready for testing (not connected). ${feature} arrives in Phase ${phase}.`
  }
}

export class IntegrationsService {
  constructor(private readonly deps: Deps) {}

  /** IX Browser is live in Phase 3: "connected" only after a real request succeeded. */
  private ixBrowserStatus(configs: ProviderConfig[]): IntegrationStatus {
    const base = configStatus('ixbrowser', 'IX Browser', PHASE.ixBrowser, 'Profile sync', configs)
    if (base.state !== 'configured') return base
    const { lastTest, counts } = this.deps.ixBrowser.overview()
    if (!lastTest) return { ...base, detail: 'Ready — run a connection test or sync profiles.' }
    if (!lastTest.ok) return { ...base, state: 'error', detail: lastTest.error?.message ?? 'The last request failed.' }
    return { ...base, state: 'connected', detail: `Last request succeeded ${new Date(lastTest.checkedAt).toLocaleString()} · ${counts.available} profiles synced` }
  }

  /**
   * AI text is live in Phase 5. The default provider (or the first ready one)
   * is "connected" only after a real request with its current settings succeeded.
   */
  private textAiStatus(configs: ProviderConfig[]): IntegrationStatus {
    const base = configStatus('text-ai', 'AI text generation', PHASE.aiProviders, 'AI generation', configs)
    if (base.state !== 'configured') return base
    const defaultId = this.deps.preferences.get().defaults.textProviderId
    const ready = configs.filter((c) => c.readiness.state === 'ready')
    const config = ready.find((c) => c.id === defaultId) ?? ready[0]!
    const test = this.deps.ai.lastTest(config)
    if (!test) return { ...base, detail: `"${config.name}" is ready — run a connection test in Settings → AI providers.` }
    if (!test.ok) return { ...base, state: 'error', detail: `"${config.name}": ${test.error?.message ?? 'the last request failed.'}` }
    return { ...base, state: 'connected', detail: `"${config.name}" answered ${new Date(test.checkedAt).toLocaleString()}${config.model ? ` · ${config.model}` : ''}` }
  }

  /** Image generation: "connected" only after a real request with the current key and endpoint succeeded. */
  private imageAiStatus(configs: ProviderConfig[]): IntegrationStatus {
    const base = configStatus('image-ai', 'AI image generation', PHASE.images, 'Image generation', configs)
    if (base.state !== 'configured') return base
    const defaultId = this.deps.preferences.get().defaults.imageProviderId
    const ready = configs.filter((c) => c.readiness.state === 'ready')
    const config = ready.find((c) => c.id === defaultId) ?? ready[0]!
    const test = this.deps.ai.lastTest(config)
    if (!test) return { ...base, detail: `"${config.name}" is ready — run a connection test in Settings → Image generation.` }
    if (!test.ok) return { ...base, state: 'error', detail: `"${config.name}": ${test.error?.message ?? 'the last request failed.'}` }
    return { ...base, state: 'connected', detail: `"${config.name}" answered ${new Date(test.checkedAt).toLocaleString()}${config.model ? ` · ${config.model}` : ''}` }
  }

  list(): IntegrationStatus[] {
    const { providers, vault, database } = this.deps
    const vaultStatus = vault.status()
    const keyCount = vault.keys().length
    const schema = database.db.pragma<number>('user_version') ?? 0

    return [
      this.ixBrowserStatus(providers.list('ixbrowser')),
      this.textAiStatus(providers.list('openai-compatible')),
      this.imageAiStatus(providers.list('image')),
      {
        id: 'database',
        name: 'Local database',
        phase: PHASE.data,
        state: database.recoveredPath ? 'degraded' : 'available',
        detail: database.recoveredPath
          ? 'An unreadable database was set aside at startup. Restore a backup from Settings → Backup & Restore.'
          : `SQLite, schema v${schema}`
      },
      {
        id: 'credentials',
        name: 'Credential vault',
        phase: PHASE.data,
        state: vaultStatus.secure ? 'available' : vaultStatus.available ? 'degraded' : 'error',
        detail: vaultStatus.secure
          ? `${vaultStatus.backend} · ${keyCount} key${keyCount === 1 ? '' : 's'} stored`
          : `${vaultStatus.backend}: ${vaultStatus.detail}`
      }
    ]
  }
}
