import type { Id, Timestamp } from './domain'
import type { ProfileAvailability, ProfileRunState } from './ixbrowser'

/**
 * X account records (Phase 4). An account is a local record the user creates;
 * it may be linked to one synchronised IX Browser profile.
 *
 * Nothing here is read from X. The username is whatever the user entered, and
 * `identity` says how far it is trusted — Axora Relay has no supported way to
 * verify an X identity yet, so the strongest state is "confirmed by you".
 */

/** unknown: no username recorded · unverified: entered, not confirmed · confirmed: the user confirmed it. */
export type AccountIdentity = 'unknown' | 'unverified' | 'confirmed'

/** Derived link state shown in the UI. */
export type AccountLinkState = 'linked' | 'not-linked' | 'profile-unavailable'

/** The linked profile as last reported by IX Browser (from the local sync table). */
export interface LinkedProfile {
  id: Id
  externalId: number
  name: string
  availability: ProfileAvailability
  runState: ProfileRunState
  openedBy: 'api' | 'client' | null
  lastSyncedAt: Timestamp
  statusCheckedAt: Timestamp | null
}

export interface Account {
  id: Id
  /** The user's own name for this record. */
  label: string
  /** X username without "@", or null when unknown. Never taken from a profile name. */
  handle: string | null
  identity: AccountIdentity
  identityConfirmedAt: Timestamp | null
  /** Local preference: may future tasks be assigned to this account? Does not change anything on X. */
  enabled: boolean
  notes: string
  profile: LinkedProfile | null
  linkedAt: Timestamp | null
  lastActiveAt: Timestamp | null
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface AccountInput {
  label: string
  /** "@name" or "name"; null or empty clears it. */
  handle: string | null
  /** Must be true to store the username as confirmed. */
  confirmIdentity: boolean
  notes: string
  enabled: boolean
}

export interface AccountCreateInput extends AccountInput {
  /** Local id of a browser profile to link right away. */
  profileId: Id | null
}

export type AccountEventKind =
  | 'created'
  | 'updated'
  | 'identity'
  | 'linked'
  | 'unlinked'
  | 'enabled'
  | 'disabled'
  | 'profile-opened'
  | 'profile-closed'
  | 'profile-renamed'
  | 'profile-unavailable'
  | 'profile-restored'
  | 'operation-failed'

export interface AccountEvent {
  id: Id
  accountId: Id
  kind: AccountEventKind
  message: string
  at: Timestamp
}

export interface AccountDetails {
  account: Account
  events: AccountEvent[]
  /** Local records that reference this account (they block removal when they would be deleted with it). */
  references: { drafts: number; scheduled: number; postLinks: number; tasks: number }
}

/** Outcome of a bulk action: what changed and what was skipped, with reasons. */
export interface BulkResult {
  changed: number
  skipped: { id: Id; reason: string }[]
}

export interface CreateFromProfilesResult extends BulkResult {
  accounts: Account[]
}
