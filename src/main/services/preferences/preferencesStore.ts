import type { Preferences, PreferencesPatch } from '@shared/types/preferences'
import type { NotificationPreferencesRepository, SettingsRepository } from '../database/repositories'
import type { ScopedLogger } from '../logging/logger'
import { DEFAULTS, preferencesSchema, type PreferenceKey } from './schema'

type Listener = (preferences: Preferences, previous: Preferences) => void

const PREFIX = 'pref.'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    result[key] = deepMerge(result[key], value)
  }
  return result as T
}

/**
 * User preferences persisted in SQLite: one app_settings row per top-level
 * key, plus notification_preferences for per-event channels. Values that fail
 * validation fall back to defaults key by key, so one bad value never wipes
 * the rest.
 */
export class PreferencesStore {
  private current: Preferences = structuredClone(DEFAULTS)
  private readonly listeners = new Set<Listener>()

  constructor(
    private readonly settings: SettingsRepository,
    private readonly notificationPrefs: NotificationPreferencesRepository,
    private readonly log: ScopedLogger
  ) {}

  /** True when nothing has been stored yet (first run or fresh database). */
  isEmpty(): boolean {
    return Object.keys(this.settings.entries(PREFIX)).length === 0
  }

  load(): Preferences {
    const stored = { ...this.settings.entries(PREFIX), notifications: this.notificationPrefs.all() }
    const merged = deepMerge(structuredClone(DEFAULTS), stored) as Record<string, unknown>
    const result: Record<string, unknown> = {}
    let rejected = 0
    for (const key of Object.keys(DEFAULTS) as PreferenceKey[]) {
      const parsed = preferencesSchema.shape[key].safeParse(merged[key])
      if (parsed.success) result[key] = parsed.data
      else {
        result[key] = structuredClone(DEFAULTS[key])
        rejected++
      }
    }
    this.current = result as unknown as Preferences
    if (rejected) this.log.warn(`${rejected} stored preference(s) were invalid and reset to defaults`)
    return this.get()
  }

  get(): Preferences {
    return structuredClone(this.current)
  }

  update(patch: PreferencesPatch): Preferences {
    const next = preferencesSchema.parse(deepMerge(this.get(), patch))
    this.log.info(`Updated ${Object.keys(patch).join(', ')}`)
    return this.commit(next)
  }

  /** Stores a complete preferences object (used by legacy import). */
  replace(next: Preferences): Preferences {
    return this.commit(preferencesSchema.parse(next))
  }

  reset(): Preferences {
    this.log.info('Preferences reset to defaults')
    return this.commit(structuredClone(DEFAULTS))
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private commit(next: Preferences): Preferences {
    const previous = this.current
    const { notifications, ...rest } = next
    this.settings.setMany(Object.fromEntries(Object.entries(rest).map(([key, value]) => [`${PREFIX}${key}`, value])))
    this.notificationPrefs.save(notifications)
    this.current = next
    const snapshot = this.get()
    this.listeners.forEach((listener) => listener(snapshot, previous))
    return snapshot
  }
}
