import type { ActivityEvent, Draft, Id } from '@shared/types/domain'
import type { AiAdapterId } from '@shared/config/aiAdapters'
import type { NotificationChannelPrefs, NotificationEvent } from '@shared/types/preferences'
import type { ProviderKind, ProviderSettings } from '@shared/types/providers'
import type { LogEntry, LogQuery } from '@shared/types/system'

/**
 * Persistence boundary. Services depend on these interfaces only; the SQLite
 * implementations live in ./sqlite. Domain repositories keep the async shape
 * from Phase 1 so a different engine (or a worker thread) can slot in later.
 */
export interface Repository<T extends { id: Id }> {
  list(): Promise<T[]>
  get(id: Id): Promise<T | null>
  upsert(item: T): Promise<T>
  remove(id: Id): Promise<void>
  count(): Promise<number>
}

export interface ActivityRepository {
  append(event: ActivityEvent): Promise<void>
  recent(limit: number): Promise<ActivityEvent[]>
  pruneBefore(iso: string): number
}

/** Key/value store for small JSON settings (app_settings). */
export interface SettingsRepository {
  get<T>(key: string): T | undefined
  set(key: string, value: unknown): void
  setMany(entries: Record<string, unknown>): void
  entries(prefix: string): Record<string, unknown>
  delete(key: string): void
}

export interface NotificationPreferencesRepository {
  all(): Partial<Record<NotificationEvent, NotificationChannelPrefs>>
  save(prefs: Record<NotificationEvent, NotificationChannelPrefs>): void
}

export interface ProviderRecord {
  id: Id
  kind: ProviderKind
  adapter: AiAdapterId | null
  name: string
  endpoint: string
  model: string | null
  enabled: boolean
  settings: ProviderSettings
  createdAt: string
  updatedAt: string
}

export interface ProviderRepository {
  list(kind?: ProviderKind): ProviderRecord[]
  get(id: Id): ProviderRecord | null
  insert(record: ProviderRecord): void
  update(record: ProviderRecord): void
  remove(id: Id): boolean
}

/** Points at an encrypted vault entry. Holds no secret material. */
export interface CredentialRefRecord {
  id: Id
  providerId: Id
  vaultKey: string
  hint: string | null
  createdAt: string
  updatedAt: string
}

export interface CredentialRefRepository {
  all(): CredentialRefRecord[]
  forProvider(providerId: Id): CredentialRefRecord | null
  upsert(record: CredentialRefRecord): void
  removeForProvider(providerId: Id): void
  clear(): number
}

export interface LogRepository {
  insert(entry: Omit<LogEntry, 'id'>): number
  query(query: LogQuery): LogEntry[]
  clear(): number
  pruneBefore(iso: string): number
}

export interface WorkspaceRepositories {
  readonly backend: 'sqlite'
  drafts: Repository<Draft>
  activity: ActivityRepository
  settings: SettingsRepository
  notificationPreferences: NotificationPreferencesRepository
  providers: ProviderRepository
  credentialRefs: CredentialRefRepository
  logs: LogRepository
}
