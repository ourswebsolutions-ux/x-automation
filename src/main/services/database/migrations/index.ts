import { m001Initial } from './001_initial'
import { m002IxBrowserSync } from './002_ixbrowser_sync'
import { m003AccountManagement } from './003_account_management'
import { m004AiProviders } from './004_ai_providers'
import { m005Generator } from './005_generator'
import { m006Images } from './006_images'
import { m007Proxies } from './007_proxies'
import { m008Publishing } from './008_publishing'
import { m009Engagement } from './009_engagement'
import { m010AutomationUsage } from './010_automation_usage'
import { m011AutomationRuns } from './011_automation_runs'
import { m012AutomationSchedules } from './012_automation_schedules'
import { m013AutoLinkAndComments } from './013_auto_link_and_comments'
import { m014CampaignPostPerAccount } from './014_campaign_post_per_account'

export interface Migration {
  version: number
  name: string
  sql: string
  /**
   * Table rebuilds need foreign keys off (SQLite's documented ALTER procedure),
   * which can only be toggled outside a transaction. The migrator re-enables
   * them afterwards and refuses to commit if foreign_key_check finds problems.
   */
  disableForeignKeys?: boolean
}

/** Append-only. Never edit a shipped migration — add a new one. */
export const MIGRATIONS: Migration[] = [m001Initial, m002IxBrowserSync, m003AccountManagement, m004AiProviders, m005Generator, m006Images, m007Proxies, m008Publishing, m009Engagement, m010AutomationUsage, m011AutomationRuns, m012AutomationSchedules, m013AutoLinkAndComments, m014CampaignPostPerAccount]

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0

/** Stamped into the file header ("AXRY") so foreign SQLite files are rejected. */
export const APPLICATION_ID = 0x41585259

/** Tables a file must contain to be accepted as one of our databases. */
export const REQUIRED_TABLES = ['schema_migrations', 'app_settings', 'provider_configs', 'drafts', 'logs']
