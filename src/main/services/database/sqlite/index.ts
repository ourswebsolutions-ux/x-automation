import type { SqliteDatabase } from '../driver'
import type { WorkspaceRepositories } from '../repositories'
import { activityRepository, draftsRepository } from './domainRepositories'
import {
  credentialRefRepository,
  logRepository,
  notificationPreferencesRepository,
  providerRepository,
  settingsRepository
} from './systemRepositories'

/** `assetExists` tells drafts whether an attached image file is still on disk (relative to the asset folder). */
export function createSqliteRepositories(db: SqliteDatabase, options: { assetExists?: (relativePath: string) => boolean } = {}): WorkspaceRepositories {
  return {
    backend: 'sqlite',
    drafts: draftsRepository(db, options.assetExists),
    activity: activityRepository(db),
    settings: settingsRepository(db),
    notificationPreferences: notificationPreferencesRepository(db),
    providers: providerRepository(db),
    credentialRefs: credentialRefRepository(db),
    logs: logRepository(db)
  }
}
