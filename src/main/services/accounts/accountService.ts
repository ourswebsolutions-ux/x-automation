import { randomUUID } from 'node:crypto'
import type {
  Account,
  AccountCreateInput,
  AccountDetails,
  AccountEventKind,
  AccountInput,
  BulkResult,
  CreateFromProfilesResult
} from '@shared/types/accounts'
import type { BrowserProfile, ProfileOperationResult } from '@shared/types/ixbrowser'
import type { AccountRecord, AccountRepository } from '../database/sqlite/accountRepository'
import type { ProfileRepository } from '../database/sqlite/profileRepository'
import { ConflictError, NotFoundError, ValidationError } from '../errors'
import type { IxBrowserService, LinkOutcome, ProfileEvent } from '../integrations/ixbrowser/ixBrowserService'
import type { ScopedLogger } from '../logging/logger'

interface Deps {
  accounts: AccountRepository
  profiles: ProfileRepository
  ixBrowser: IxBrowserService
  log: ScopedLogger
  onChange: () => void
}

/** X usernames: 1–15 letters, digits or underscores. */
export const HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/
const EVENT_LIMIT = 50

export function normalizeHandle(value: string | null): string | null {
  const handle = (value ?? '').trim().replace(/^@/, '')
  if (!handle) return null
  if (!HANDLE_PATTERN.test(handle)) throw new ValidationError('An X username has 1–15 letters, numbers or underscores.')
  return handle
}

const short = (id: string) => id.slice(0, 8)

/**
 * Local X account records and their links to IX Browser profiles.
 *
 * Everything here is local bookkeeping. No method contacts X, and enabling or
 * disabling an account only changes whether X Auto may assign it work.
 * Profile open/close goes through IxBrowserService — no API logic is duplicated.
 */
export class AccountService {
  constructor(private readonly deps: Deps) {
    deps.ixBrowser.onProfileEvents((events) => this.recordProfileEvents(events))
    deps.ixBrowser.setLinker(() => this.linkSyncedProfiles())
  }

  list(): Account[] {
    return this.deps.accounts.list()
  }

  details(id: string): AccountDetails {
    const account = this.require(id)
    return { account, events: this.deps.accounts.events(id, EVENT_LIMIT), references: this.deps.accounts.references(id) }
  }

  create(input: AccountCreateInput): Account {
    const now = new Date().toISOString()
    const identity = this.resolveIdentity(input, null, now)
    const record: AccountRecord = {
      id: randomUUID(),
      label: this.label(input.label),
      ...identity,
      profileId: null,
      linkedAt: null,
      enabled: input.enabled,
      notes: input.notes.trim(),
      createdAt: now,
      updatedAt: now
    }
    this.deps.accounts.transaction(() => {
      this.assertHandleFree(record.handle, null)
      this.deps.accounts.insert(record)
      this.event(record.id, 'created', 'Account record created', now)
      if (record.handle) this.event(record.id, 'identity', this.identityMessage(record), now)
      if (input.profileId) this.linkInTransaction(record.id, input.profileId, now)
    })
    this.deps.log.info(`Created account ${short(record.id)}`, { linked: Boolean(input.profileId), identity: record.identity })
    this.deps.onChange()
    return this.require(record.id)
  }

  update(id: string, input: AccountInput): Account {
    const now = new Date().toISOString()
    this.deps.accounts.transaction(() => {
      const previous = this.requireRecord(id)
      const next: AccountRecord = {
        ...previous,
        label: this.label(input.label),
        ...this.resolveIdentity(input, previous, now),
        enabled: input.enabled,
        notes: input.notes.trim(),
        updatedAt: now
      }
      this.assertHandleFree(next.handle, id)
      this.deps.accounts.update(next)

      if (next.label !== previous.label) this.event(id, 'updated', `Label changed from “${previous.label}” to “${next.label}”`, now)
      if (next.notes !== previous.notes) this.event(id, 'updated', 'Notes updated', now)
      if (next.handle !== previous.handle || next.identity !== previous.identity) this.event(id, 'identity', this.identityMessage(next), now)
      if (next.enabled !== previous.enabled) this.enabledEvent(id, next.enabled, now)
    })
    this.deps.log.info(`Updated account ${short(id)}`)
    this.deps.onChange()
    return this.require(id)
  }

  /** Links (or re-links) an account to an available, unclaimed profile. */
  link(id: string, profileId: string): Account {
    const now = new Date().toISOString()
    this.deps.accounts.transaction(() => this.linkInTransaction(id, profileId, now))
    this.deps.onChange()
    return this.require(id)
  }

  /** Removes the profile association only. The IX Browser profile is not touched. */
  unlink(ids: string[]): BulkResult {
    const now = new Date().toISOString()
    const result = this.bulk(ids, (record) => {
      if (!record.profileId) return 'Not linked to a profile'
      const profile = this.deps.profiles.get(record.profileId)
      if (profile && this.deps.ixBrowser.isPending(profile.externalId)) return 'An open or close request is in progress'
      this.deps.accounts.update({ ...record, profileId: null, linkedAt: null, updatedAt: now })
      // Disconnected on purpose: syncs leave this profile alone until it is connected again.
      if (profile) this.deps.profiles.setLinkExcluded(profile.id, now, record.id)
      this.event(
        record.id,
        'unlinked',
        profile ? `Unlinked from profile “${profile.name}” (#${profile.externalId}). The browser profile itself was not changed.` : 'Unlinked from its profile',
        now
      )
      return null
    })
    if (result.changed) this.deps.log.info(`Unlinked ${result.changed} account(s) from their profiles`)
    return result
  }

  /** Local preference only — does not change anything on X. */
  setEnabled(ids: string[], enabled: boolean): BulkResult {
    const now = new Date().toISOString()
    const result = this.bulk(ids, (record) => {
      if (record.enabled === enabled) return enabled ? 'Already enabled' : 'Already disabled'
      this.deps.accounts.update({ ...record, enabled, updatedAt: now })
      this.enabledEvent(record.id, enabled, now)
      return null
    })
    if (result.changed) this.deps.log.info(`${enabled ? 'Enabled' : 'Disabled'} ${result.changed} account(s) for task assignment`)
    return result
  }

  /**
   * Deletes local account records. Browser profiles are never deleted. Records
   * that scheduled posts or post links depend on are skipped, because removing
   * the account would delete those too.
   */
  remove(ids: string[]): BulkResult {
    const result = this.bulk(ids, (record) => {
      const refs = this.deps.accounts.references(record.id)
      if (refs.scheduled || refs.postLinks) {
        return `Has ${refs.scheduled} scheduled post(s) and ${refs.postLinks} post link(s) — disable it instead`
      }
      // A removed account's profile is not linked again by the next sync (connect it again to use it).
      if (record.profileId) this.deps.profiles.setLinkExcluded(record.profileId, new Date().toISOString())
      this.deps.accounts.remove(record.id)
      return null
    })
    if (result.changed) this.deps.log.warn(`Removed ${result.changed} account record(s); browser profiles were not changed`)
    return result
  }

  /**
   * Creates one record per selected profile, labelled with the profile name.
   * The username stays unknown: a profile name is not an X identity.
   * Also used to connect a profile again after it was disconnected.
   */
  createFromProfiles(profileIds: string[]): CreateFromProfilesResult {
    const now = new Date().toISOString()
    const created: string[] = []
    const skipped: BulkResult['skipped'] = []
    this.deps.accounts.transaction(() => {
      for (const profileId of new Set(profileIds)) {
        const profile = this.deps.profiles.get(profileId)
        if (!profile) skipped.push({ id: profileId, reason: 'Profile not found — sync profiles again' })
        else if (profile.availability !== 'available') skipped.push({ id: profileId, reason: 'No longer reported by IX Browser' })
        else if (this.deps.accounts.byProfile(profileId)) skipped.push({ id: profileId, reason: 'Already linked to an account' })
        else created.push(this.insertFromProfile(profile, now, 'Account record created from a browser profile'))
      }
    })
    if (created.length) {
      this.deps.log.info(`Created ${created.length} account record(s) from browser profiles`)
      this.deps.onChange()
    }
    return { changed: created.length, skipped, accounts: created.map((id) => this.require(id)) }
  }

  /**
   * Connects a profile again after it was disconnected: the account that was linked before is
   * linked again (its username, settings and history are kept); without one, a new record is made.
   */
  connectProfile(profileId: string): Account {
    const now = new Date().toISOString()
    let id: string | null = null
    this.deps.accounts.transaction(() => {
      const profile = this.deps.profiles.get(profileId)
      if (!profile) throw new NotFoundError('That browser profile is not in the local list. Sync profiles and try again.')
      const owner = this.deps.accounts.byProfile(profileId)
      if (owner) {
        id = owner.id
        return
      }
      const previous = this.deps.profiles.disconnectedAccount(profileId)
      const record = previous ? this.deps.accounts.record(previous) : null
      if (record && !record.profileId) {
        this.linkInTransaction(record.id, profileId, now)
        id = record.id
      } else {
        if (profile.availability !== 'available') throw new ConflictError('IX Browser no longer reports that profile. Sync profiles, then try again.')
        id = this.insertFromProfile(profile, now, 'Account record created when the profile was connected')
      }
    })
    this.deps.onChange()
    return this.require(id!)
  }

  /**
   * After a sync: every available profile that has no account (and that you did not disconnect)
   * gets one and is linked to it, so it can be used right away. Idempotent — a profile is linked
   * once, and later syncs find it linked. Each profile is linked on its own, so one failure is
   * reported without blocking the others; the next sync retries it.
   */
  linkSyncedProfiles(): LinkOutcome {
    const now = new Date().toISOString()
    const failed: LinkOutcome['failed'] = []
    let linked = 0
    for (const profile of this.deps.profiles.unlinkedAvailable()) {
      try {
        this.deps.accounts.transaction(() => {
          // Re-checked inside the transaction: another path may have linked it since the list was read.
          if (this.deps.accounts.byProfile(profile.id)) return
          this.insertFromProfile(profile, now, 'Account record created automatically when the profile was synced')
          linked++
        })
      } catch (error) {
        failed.push({ profileId: profile.id, name: profile.name, reason: error instanceof Error ? error.message.slice(0, 200) : 'Could not be linked.' })
      }
    }
    if (linked) {
      this.deps.log.info(`Linked ${linked} synced profile(s) automatically`)
      this.deps.onChange()
    }
    return { linked, failed }
  }

  async openProfile(id: string): Promise<ProfileOperationResult> {
    return this.deps.ixBrowser.openProfile(this.linkedExternalId(id))
  }

  async closeProfile(id: string): Promise<ProfileOperationResult> {
    return this.deps.ixBrowser.closeProfile(this.linkedExternalId(id))
  }

  pruneEvents(beforeIso: string): number {
    return this.deps.accounts.pruneEventsBefore(beforeIso)
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Inserts an account record for a profile and links it (inside the caller's transaction). */
  private insertFromProfile(profile: BrowserProfile, now: string, message: string): string {
    const id = randomUUID()
    this.deps.accounts.insert({
      id,
      label: profile.name.trim().slice(0, 80) || `Profile #${profile.externalId}`,
      handle: null,
      identity: 'unknown',
      identityConfirmedAt: null,
      profileId: null,
      linkedAt: null,
      enabled: true,
      notes: '',
      createdAt: now,
      updatedAt: now
    })
    this.event(id, 'created', message, now)
    this.linkInTransaction(id, profile.id, now)
    return id
  }

  private linkedExternalId(id: string): number {
    const account = this.require(id)
    if (!account.profile) throw new ConflictError('This account is not linked to a browser profile.')
    return account.profile.externalId
  }

  private linkInTransaction(id: string, profileId: string, now: string): void {
    const record = this.requireRecord(id)
    const profile = this.deps.profiles.get(profileId)
    if (!profile) throw new NotFoundError('That browser profile is not in the local list. Sync profiles and try again.')
    if (record.profileId === profileId) return
    if (profile.availability !== 'available') {
      throw new ConflictError('IX Browser no longer reports that profile. Sync profiles, then choose an available one.')
    }
    const owner = this.deps.accounts.byProfile(profileId)
    if (owner) throw new ConflictError(`Profile #${profile.externalId} is already linked to “${owner.label}”. Unlink it there first.`)

    const previous = record.profileId ? this.deps.profiles.get(record.profileId) : null
    this.deps.accounts.update({ ...record, profileId, linkedAt: now, updatedAt: now })
    if (profile.linkExcludedAt) this.deps.profiles.setLinkExcluded(profileId, null)
    if (previous) this.event(id, 'unlinked', `Unlinked from profile “${previous.name}” (#${previous.externalId})`, now)
    this.event(id, 'linked', `Linked to profile “${profile.name}” (#${profile.externalId})`, now)
    this.deps.log.info(`Linked account ${short(id)} to profile ${profile.externalId}`)
  }

  private bulk(ids: string[], apply: (record: AccountRecord) => string | null): BulkResult {
    const skipped: BulkResult['skipped'] = []
    let changed = 0
    this.deps.accounts.transaction(() => {
      for (const id of new Set(ids)) {
        const record = this.deps.accounts.record(id)
        const reason = record ? apply(record) : 'Account not found'
        if (reason) skipped.push({ id, reason })
        else changed++
      }
    })
    if (changed) this.deps.onChange()
    return { changed, skipped }
  }

  private resolveIdentity(input: AccountInput, previous: AccountRecord | null, now: string) {
    const handle = normalizeHandle(input.handle)
    if (!handle) return { handle: null, identity: 'unknown' as const, identityConfirmedAt: null }
    if (!input.confirmIdentity) return { handle, identity: 'unverified' as const, identityConfirmedAt: null }
    const unchanged = previous?.identity === 'confirmed' && previous.handle === handle
    return { handle, identity: 'confirmed' as const, identityConfirmedAt: unchanged ? previous.identityConfirmedAt : now }
  }

  private identityMessage(record: Pick<AccountRecord, 'handle' | 'identity'>): string {
    if (!record.handle) return 'X username cleared'
    return record.identity === 'confirmed' ? `X username @${record.handle} confirmed by you` : `X username @${record.handle} recorded (not verified)`
  }

  private assertHandleFree(handle: string | null, selfId: string | null): void {
    if (!handle) return
    const owner = this.deps.accounts.byHandle(handle)
    if (owner && owner.id !== selfId) throw new ConflictError(`@${handle} is already recorded on “${owner.label}”.`)
  }

  private label(value: string): string {
    const label = value.trim()
    if (!label) throw new ValidationError('Give the account a label.')
    if (label.length > 80) throw new ValidationError('Labels can be up to 80 characters.')
    return label
  }

  private enabledEvent(id: string, enabled: boolean, at: string): void {
    this.event(
      id,
      enabled ? 'enabled' : 'disabled',
      enabled ? 'Enabled for task assignment' : 'Disabled for task assignment (local setting — the X account is unaffected)',
      at
    )
  }

  private event(accountId: string, kind: AccountEventKind, message: string, at: string): void {
    this.deps.accounts.addEvent({ id: randomUUID(), accountId, kind, message: message.slice(0, 300), at })
  }

  private require(id: string): Account {
    const account = this.deps.accounts.get(id)
    if (!account) throw new NotFoundError('That account no longer exists.')
    return account
  }

  private requireRecord(id: string): AccountRecord {
    const record = this.deps.accounts.record(id)
    if (!record) throw new NotFoundError('That account no longer exists.')
    return record
  }

  /** Mirrors profile changes into the history of the linked account. */
  private recordProfileEvents(events: ProfileEvent[]): void {
    const at = new Date().toISOString()
    let touched = false
    this.deps.accounts.transaction(() => {
      for (const e of events) {
        const account = this.deps.accounts.byProfile(e.profileId)
        if (!account) continue
        touched = true
        switch (e.kind) {
          case 'renamed':
            this.event(account.id, 'profile-renamed', `Profile renamed in IX Browser: “${e.from}” → “${e.to}”`, at)
            break
          case 'unavailable':
            this.event(account.id, 'profile-unavailable', `Profile #${e.externalId} is no longer reported by IX Browser`, at)
            break
          case 'restored':
            this.event(account.id, 'profile-restored', `Profile #${e.externalId} is reported by IX Browser again`, at)
            break
          case 'opened':
          case 'closed':
            this.event(
              account.id,
              e.kind === 'opened' ? 'profile-opened' : 'profile-closed',
              `Profile ${e.kind}${e.confirmed ? '' : ' — IX Browser has not confirmed the new state yet'}`,
              at
            )
            this.deps.accounts.touch(account.id, at)
            break
          case 'open-failed':
          case 'close-failed':
            this.event(account.id, 'operation-failed', `Could not ${e.kind === 'open-failed' ? 'open' : 'close'} profile: ${e.message}`, at)
            break
        }
      }
    })
    if (touched) this.deps.onChange()
  }
}
