import { randomUUID } from 'node:crypto'
import { readFile, rename } from 'node:fs/promises'
import { DEFAULT_PREFERENCES } from '@shared/config/app'
import { PROVIDER_KINDS, validateEndpoint } from '@shared/config/providers'
import type { Preferences } from '@shared/types/preferences'
import type { ProviderRepository } from '../database/repositories'
import type { ScopedLogger } from '../logging/logger'
import { deepMerge, type PreferencesStore } from './preferencesStore'
import { preferencesSchema } from './schema'

interface LegacyPreferences {
  theme?: unknown
  sidebarCollapsed?: unknown
  showDemoData?: unknown
  reduceMotion?: unknown
  startPage?: unknown
  notifications?: { taskFailures?: boolean; scheduleReminders?: boolean; desktopAlerts?: boolean }
  integrations?: { ixBrowser?: { endpoint?: string } }
}

/**
 * One-time import of Phase 1's preferences.json into SQLite. The IX Browser
 * endpoint becomes a provider configuration. The old file is renamed, not
 * deleted.
 */
export async function importLegacyPreferences(
  filePath: string,
  store: PreferencesStore,
  providers: ProviderRepository,
  log: ScopedLogger
): Promise<void> {
  let legacy: LegacyPreferences
  try {
    legacy = JSON.parse(await readFile(filePath, 'utf8')) as LegacyPreferences
  } catch {
    return // No legacy file (fresh install) or unreadable — nothing to import.
  }

  const desktop = legacy.notifications?.desktopAlerts === true
  const candidate = deepMerge<Preferences>(structuredClone(DEFAULT_PREFERENCES), {
    theme: legacy.theme,
    sidebarCollapsed: legacy.sidebarCollapsed,
    showDemoData: legacy.showDemoData,
    reduceMotion: legacy.reduceMotion,
    startPage: legacy.startPage,
    notifications: {
      taskFailures: { inApp: legacy.notifications?.taskFailures ?? true, desktop },
      scheduleReminders: { inApp: legacy.notifications?.scheduleReminders ?? true, desktop },
      systemNotices: { inApp: true, desktop }
    }
  })
  const parsed = preferencesSchema.safeParse(candidate)
  store.replace(parsed.success ? parsed.data : structuredClone(DEFAULT_PREFERENCES))

  const endpoint = legacy.integrations?.ixBrowser?.endpoint
  if (endpoint && !validateEndpoint('ixbrowser', endpoint) && providers.list('ixbrowser').length === 0) {
    const at = new Date().toISOString()
    providers.insert({
      id: randomUUID(),
      kind: 'ixbrowser',
      adapter: null,
      name: PROVIDER_KINDS.ixbrowser.defaultName,
      endpoint,
      model: null,
      enabled: true,
      settings: { timeoutMs: 10_000, retries: 1 },
      createdAt: at,
      updatedAt: at
    })
  }

  await rename(filePath, `${filePath}.migrated`).catch(() => undefined)
  log.info('Imported preferences from the previous version')
}
