import type { Id, Timestamp } from './domain'

/**
 * IX Browser Local API V2 — types for data that crosses into the renderer.
 * Only non-sensitive profile metadata is ever stored or shown.
 */

export type IxErrorKind =
  | 'not-configured' // no enabled, complete IX Browser configuration
  | 'unreachable' // nothing listening (IX Browser closed or Local API disabled)
  | 'timeout'
  | 'unsupported' // endpoint missing — not a Local API V2 server
  | 'http' // non-200 status
  | 'api' // the API answered with a non-zero error code
  | 'malformed' // response did not match the documented contract
  | 'cancelled'
  | 'busy' // an equivalent operation is already running

export interface IxError {
  kind: IxErrorKind
  message: string
  /** What the user can do about it. */
  hint: string
  /** API error code or HTTP status, when the server supplied one. */
  code: number | null
}

export interface ConnectionTestResult {
  ok: boolean
  providerId: Id
  endpoint: string
  checkedAt: Timestamp
  latencyMs: number | null
  /** Total profiles reported by the API (from a real profile-list call). */
  totalProfiles: number | null
  apiVersion: 'v2'
  error: IxError | null
}

export type ProfileAvailability = 'available' | 'unavailable'
export type ProfileRunState = 'running' | 'closed' | 'unknown'

export interface BrowserProfile {
  id: Id
  /** The profile_id from IX Browser (an integer in the API). */
  externalId: number
  name: string
  siteUrl: string | null
  availability: ProfileAvailability
  runState: ProfileRunState
  /** Which opened-list reported it: opened via the Local API or the desktop client. */
  openedBy: 'api' | 'client' | null
  firstSeenAt: Timestamp
  lastSyncedAt: Timestamp
  statusCheckedAt: Timestamp | null
  /** Change seen in the most recent sync. */
  lastChange: 'new' | 'updated' | 'unchanged' | 'unavailable'
  /** You disconnected this profile's account: syncs leave it unlinked until you connect it again. */
  linkExcludedAt: Timestamp | null
  /** Additional non-sensitive fields returned by the API, shown as-is. */
  metadata: Record<string, string | number | boolean>
}

export type SyncRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface SyncRun {
  id: Id
  status: SyncRunStatus
  startedAt: Timestamp
  finishedAt: Timestamp | null
  discovered: number
  added: number
  updated: number
  unavailable: number
  duplicates: number
  /** Profiles linked to an account automatically after this sync. */
  linked: number
  /** Profiles that could not be linked (see linkErrors); syncing again retries them. */
  linkFailed: number
  linkErrors: { profileId: Id; name: string; reason: string }[]
  error: string | null
}

export interface SyncProgress {
  runId: Id
  stage: 'listing' | 'status' | 'saving' | 'done'
  fetched: number
  total: number | null
}

export type ProfileOperation = 'open' | 'close'

export interface IxBrowserOverview {
  configured: boolean
  providerId: Id | null
  providerName: string | null
  endpoint: string | null
  lastTest: ConnectionTestResult | null
  lastSync: SyncRun | null
  syncing: boolean
  counts: { total: number; available: number; running: number; unavailable: number }
  /** Profiles with an open/close request in flight, by external id. */
  pending: Record<number, ProfileOperation>
}

export interface ProfileOperationResult {
  profile: BrowserProfile
  /** True when IX Browser confirmed the new state via a status refresh. */
  confirmed: boolean
}
