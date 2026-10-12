import { createHash, randomUUID } from 'node:crypto'
import type {
  BrowserProfile,
  ConnectionTestResult,
  IxBrowserOverview,
  ProfileOperation,
  ProfileOperationResult,
  SyncProgress,
  SyncRun
} from '@shared/types/ixbrowser'
import type { ProviderConfig } from '@shared/types/providers'
import type { ActivityRepository, SettingsRepository } from '../../database/repositories'
import type { ProfileChange, ProfileRepository, ProfileUpsert } from '../../database/sqlite/profileRepository'
import type { ScopedLogger } from '../../logging/logger'
import type { ProviderService } from '../../providers/providerService'
import { IxBrowserError, IxBrowserHttpClient } from './client'
import type { IxProfileRecord } from './types'

interface Deps {
  providers: ProviderService
  profiles: ProfileRepository
  settings: SettingsRepository
  activity: ActivityRepository
  log: ScopedLogger
  /** Swappable for tests. */
  fetchImpl?: typeof fetch
  onChange: () => void
  onProgress: (progress: SyncProgress) => void
}

/** Profile-level changes other services (accounts) record in their own history. */
export type ProfileEvent =
  | ProfileChange
  | { profileId: string; externalId: number; kind: 'opened' | 'closed'; confirmed: boolean }
  | { profileId: string; externalId: number; kind: 'open-failed' | 'close-failed'; message: string }

/** What automatic linking did after a sync (see AccountService.linkSyncedProfiles). */
export interface LinkOutcome {
  linked: number
  failed: SyncRun['linkErrors']
}

const LAST_TEST_KEY = 'ixbrowser.lastTest'

const notConfigured = () =>
  new IxBrowserError(
    'not-configured',
    'No IX Browser connection is set up.',
    'Add and enable an IX Browser connection in Settings → IX Browser.'
  )

const hashOf = (record: IxProfileRecord) =>
  createHash('sha256').update(JSON.stringify([record.name, record.siteUrl, Object.entries(record.extra).sort()])).digest('hex')

/**
 * Orchestrates the IX Browser Local API: connection tests, profile sync and
 * open/close. Network work happens here (main process) only; the renderer
 * sees results through IPC.
 */
export class IxBrowserService {
  private syncing: { runId: string; controller: AbortController; promise: Promise<SyncRun> } | null = null
  private readonly pending = new Map<number, ProfileOperation>()
  private readonly profileListeners = new Set<(events: ProfileEvent[]) => void>()
  /** Debugging addresses returned by profile-open, kept in memory only (by external id). */
  private readonly debugAddresses = new Map<number, string>()
  /** Links newly synced profiles to accounts (set by AccountService). */
  private linker: (() => LinkOutcome) | null = null

  constructor(private readonly deps: Deps) {
    const closed = deps.profiles.closeStaleRuns(new Date().toISOString())
    if (closed) deps.log.warn(`Closed ${closed} interrupted sync run(s)`)
  }

  /** Runs after every successful sync, so every synced profile is ready to use without linking it by hand. */
  setLinker(linker: () => LinkOutcome): void {
    this.linker = linker
  }

  onProfileEvents(listener: (events: ProfileEvent[]) => void): () => void {
    this.profileListeners.add(listener)
    return () => this.profileListeners.delete(listener)
  }

  private emit(events: ProfileEvent[]): void {
    if (!events.length) return
    for (const listener of this.profileListeners) {
      try {
        listener(events)
      } catch (error) {
        this.deps.log.error('Profile event listener failed', error)
      }
    }
  }

  /**
   * The debugging address IX Browser returned when X Auto opened this
   * profile through the Local API (null if it was opened elsewhere, closed,
   * or IX Browser did not return one).
   */
  debuggingAddressFor(externalId: number): string | null {
    const profile = this.deps.profiles.getByExternalId(externalId)
    if (!profile || profile.runState !== 'running') {
      this.debugAddresses.delete(externalId)
      return null
    }
    return this.debugAddresses.get(externalId) ?? null
  }

  /**
   * Applies a custom proxy through the documented Local API action. Refused
   * while the profile is open: IX Browser applies proxy settings when a
   * profile starts, so a running profile would keep its old connection.
   */
  async applyCustomProxy(
    externalId: number,
    proxy: { scheme: 'http' | 'https' | 'socks5'; host: string; port: number; username: string | null; password: string | null }
  ): Promise<void> {
    const config = this.requireConfig()
    const profile = this.deps.profiles.getByExternalId(externalId)
    if (!profile) throw new IxBrowserError('not-configured', 'That profile is not in the local list. Sync profiles first.', '')
    if (profile.availability === 'unavailable') throw new IxBrowserError('api', 'This profile is no longer reported by IX Browser.', 'Sync profiles to refresh the list.')
    if (this.pending.has(externalId)) throw new IxBrowserError('busy', 'This profile is being opened or closed.', 'Wait for that to finish.')
    if (profile.runState === 'running') {
      throw new IxBrowserError('busy', 'This profile is open, so the proxy was not applied.', 'Close it in IX Browser (or from the profile list), then apply the proxy again. IX Browser uses proxy settings when a profile starts.')
    }
    try {
      await this.client(config).updateCustomProxy(externalId, { type: proxy.scheme, host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password })
      this.deps.log.info(`Applied a custom proxy to profile ${externalId}`, { scheme: proxy.scheme, auth: Boolean(proxy.username) })
    } catch (error) {
      const ix = error instanceof IxBrowserError ? error : new IxBrowserError('malformed', 'Request failed unexpectedly.', '')
      this.deps.log.warn(`IX Browser did not apply the proxy to profile ${externalId}: ${ix.message}`, { kind: ix.kind, code: ix.code })
      throw ix
    }
  }

  /** True while an open/close request for this profile is in flight. */
  isPending(externalId: number): boolean {
    return this.pending.has(externalId)
  }

  /** The first enabled IX Browser configuration that is complete. */
  activeConfig(): ProviderConfig | null {
    return this.deps.providers.list('ixbrowser').find((config) => config.readiness.state === 'ready') ?? null
  }

  private client(config: ProviderConfig): IxBrowserHttpClient {
    return new IxBrowserHttpClient({
      endpoint: config.endpoint,
      timeoutMs: config.settings.timeoutMs,
      retries: config.settings.retries,
      fetchImpl: this.deps.fetchImpl
    })
  }

  private requireConfig(): ProviderConfig {
    const config = this.activeConfig()
    if (!config) throw notConfigured()
    return config
  }

  lastTest(): ConnectionTestResult | null {
    return this.deps.settings.get<ConnectionTestResult>(LAST_TEST_KEY) ?? null
  }

  overview(): IxBrowserOverview {
    const config = this.activeConfig()
    const lastTest = this.lastTest()
    return {
      configured: Boolean(config),
      providerId: config?.id ?? null,
      providerName: config?.name ?? null,
      endpoint: config?.endpoint ?? null,
      lastTest: lastTest && config && lastTest.providerId === config.id ? lastTest : null,
      lastSync: this.deps.profiles.runs(1)[0] ?? null,
      syncing: this.syncing !== null,
      counts: this.deps.profiles.counts(),
      pending: Object.fromEntries(this.pending)
    }
  }

  listProfiles(): BrowserProfile[] {
    return this.deps.profiles.list()
  }

  syncHistory(limit = 10): SyncRun[] {
    return this.deps.profiles.runs(limit)
  }

  /** A genuine profile-list request. Success is only reported when IX Browser answered. */
  async testConnection(providerId?: string): Promise<ConnectionTestResult> {
    const config = providerId ? this.deps.providers.get(providerId) : this.requireConfig()
    if (config.kind !== 'ixbrowser') throw new IxBrowserError('not-configured', 'That is not an IX Browser configuration.', '')
    const base: Omit<ConnectionTestResult, 'ok' | 'latencyMs' | 'totalProfiles' | 'error'> = {
      providerId: config.id,
      endpoint: config.endpoint,
      checkedAt: new Date().toISOString(),
      apiVersion: 'v2'
    }
    let result: ConnectionTestResult
    try {
      const { latencyMs, total } = await this.client(config).ping()
      result = { ...base, ok: true, latencyMs, totalProfiles: total, error: null }
      this.deps.log.success('IX Browser connection test passed', { latencyMs, profiles: total })
    } catch (error) {
      const ix = error instanceof IxBrowserError ? error : new IxBrowserError('unreachable', 'Request failed.', '')
      result = { ...base, ok: false, latencyMs: null, totalProfiles: null, error: ix.toJSON() }
      this.deps.log.warn(`IX Browser connection test failed: ${ix.message}`, { kind: ix.kind, code: ix.code })
    }
    this.deps.settings.set(LAST_TEST_KEY, result)
    this.deps.onChange()
    return result
  }

  /**
   * Fetches every profile and reconciles the local table. Only one sync runs
   * at a time — a second request joins the running one instead of starting
   * another.
   */
  sync(): Promise<SyncRun> {
    if (this.syncing) return this.syncing.promise
    const config = this.requireConfig()
    const runId = randomUUID()
    const controller = new AbortController()
    const promise = this.runSync(config, runId, controller.signal).finally(() => {
      this.syncing = null
      this.deps.onChange()
    })
    this.syncing = { runId, controller, promise }
    this.deps.onChange()
    return promise
  }

  cancelSync(): boolean {
    if (!this.syncing) return false
    this.syncing.controller.abort()
    return true
  }

  private async runSync(config: ProviderConfig, runId: string, signal: AbortSignal): Promise<SyncRun> {
    const startedAt = new Date().toISOString()
    const { profiles, log } = this.deps
    profiles.startRun(runId, config.id, startedAt)
    log.info('Profile sync started', { provider: config.name })
    const client = this.client(config)
    const counts = { discovered: 0, added: 0, updated: 0, unavailable: 0, duplicates: 0, linked: 0, linkFailed: 0, linkErrors: [] as SyncRun['linkErrors'] }

    try {
      this.deps.onProgress({ runId, stage: 'listing', fetched: 0, total: null })
      const records = await client.listAllProfiles(signal, (fetched, total) =>
        this.deps.onProgress({ runId, stage: 'listing', fetched, total })
      )

      // The API should not repeat an id, but pagination shifting under us can. Keep the first.
      const unique = new Map<number, IxProfileRecord>()
      for (const record of records) {
        if (unique.has(record.profileId)) counts.duplicates++
        else unique.set(record.profileId, record)
      }
      if (counts.duplicates) log.warn(`Ignored ${counts.duplicates} duplicate profile id(s) in the API response`)
      counts.discovered = unique.size

      this.deps.onProgress({ runId, stage: 'status', fetched: unique.size, total: unique.size })
      const opened = await client.openedProfiles(signal)
      if (signal.aborted) throw new IxBrowserError('cancelled', 'Cancelled.', '')

      this.deps.onProgress({ runId, stage: 'saving', fetched: unique.size, total: unique.size })
      const at = new Date().toISOString()
      const upserts: ProfileUpsert[] = [...unique.values()].map((record) => ({
        externalId: record.profileId,
        name: record.name,
        siteUrl: record.siteUrl,
        metadata: record.extra,
        contentHash: hashOf(record)
      }))
      const { changes, ...applied } = profiles.applySync(config.id, upserts, at, randomUUID)
      Object.assign(counts, applied)
      profiles.applyRunState(new Set(opened.api), opened.client ? new Set(opened.client) : null, at)

      // Every available profile gets an account record and link; one that can't be linked is reported, and the next sync retries it.
      if (this.linker) {
        let outcome: LinkOutcome
        try {
          outcome = this.linker()
        } catch (error) {
          log.error('Automatic profile linking failed', error)
          outcome = { linked: 0, failed: profiles.unlinkedAvailable().map((p) => ({ profileId: p.id, name: p.name, reason: 'Linking stopped unexpectedly. Sync again to retry.' })) }
        }
        counts.linked = outcome.linked
        counts.linkFailed = outcome.failed.length
        counts.linkErrors = outcome.failed
        if (outcome.failed.length) log.warn(`${outcome.failed.length} profile(s) could not be linked automatically`)
      }

      const run: SyncRun = { id: runId, status: 'succeeded', startedAt, finishedAt: new Date().toISOString(), ...counts, error: null }
      profiles.finishRun(run)
      this.deps.onProgress({ runId, stage: 'done', fetched: unique.size, total: unique.size })
      log.success('Profile sync finished', { ...counts })
      this.emit(changes)
      await this.deps.activity.append({
        id: randomUUID(),
        level: 'success',
        message: `Synced ${counts.discovered} browser profile${counts.discovered === 1 ? '' : 's'}`,
        subject:
          counts.added || counts.unavailable || counts.linked || counts.linkFailed
            ? [`${counts.added} new`, `${counts.unavailable} unavailable`, counts.linked && `${counts.linked} linked`, counts.linkFailed && `${counts.linkFailed} not linked`].filter(Boolean).join(' · ')
            : null,
        at: run.finishedAt!
      })
      // A completed sync is also a successful real request.
      this.deps.settings.set(LAST_TEST_KEY, {
        ok: true,
        providerId: config.id,
        endpoint: config.endpoint,
        checkedAt: run.finishedAt!,
        latencyMs: null,
        totalProfiles: counts.discovered,
        apiVersion: 'v2',
        error: null
      } satisfies ConnectionTestResult)
      return run
    } catch (error) {
      const ix = error instanceof IxBrowserError ? error : new IxBrowserError('malformed', 'Sync failed unexpectedly.', '')
      const status = ix.kind === 'cancelled' ? 'cancelled' : 'failed'
      const run: SyncRun = {
        id: runId,
        status,
        startedAt,
        finishedAt: new Date().toISOString(),
        ...counts,
        error: status === 'cancelled' ? null : ix.message
      }
      profiles.finishRun(run)
      if (status === 'cancelled') log.info('Profile sync cancelled')
      else {
        log.error(`Profile sync failed: ${ix.message}`, undefined, { kind: ix.kind, code: ix.code })
        await this.deps.activity.append({ id: randomUUID(), level: 'error', message: 'Profile sync failed', subject: ix.message.slice(0, 80), at: run.finishedAt! })
      }
      throw ix
    }
  }

  /** Re-reads the opened-profile lists without a full sync. */
  async refreshStatus(): Promise<BrowserProfile[]> {
    const config = this.requireConfig()
    const opened = await this.client(config).openedProfiles()
    this.deps.profiles.applyRunState(new Set(opened.api), opened.client ? new Set(opened.client) : null, new Date().toISOString())
    this.deps.onChange()
    return this.deps.profiles.list()
  }

  openProfile(externalId: number): Promise<ProfileOperationResult> {
    return this.operate(externalId, 'open')
  }

  closeProfile(externalId: number): Promise<ProfileOperationResult> {
    return this.operate(externalId, 'close')
  }

  private async operate(externalId: number, operation: ProfileOperation): Promise<ProfileOperationResult> {
    const config = this.requireConfig()
    const profile = this.deps.profiles.getByExternalId(externalId)
    if (!profile) throw new IxBrowserError('not-configured', 'That profile is not in the local list. Sync profiles first.', '')
    if (profile.availability === 'unavailable') {
      throw new IxBrowserError('api', 'This profile is no longer reported by IX Browser.', 'Sync profiles to refresh the list.')
    }
    const inFlight = this.pending.get(externalId)
    if (inFlight) {
      throw new IxBrowserError('busy', `This profile is already being ${inFlight === 'open' ? 'opened' : 'closed'}.`, 'Wait for the current request to finish.')
    }
    if (operation === 'open' && profile.runState === 'running') {
      throw new IxBrowserError('busy', 'This profile is already open.', 'Refresh status if the window was closed outside X Auto.')
    }

    this.pending.set(externalId, operation)
    this.deps.onChange()
    const client = this.client(config)
    try {
      if (operation === 'open') {
        const opened = await client.openProfile(externalId)
        if (opened.debuggingAddress) this.debugAddresses.set(externalId, opened.debuggingAddress)
        else this.debugAddresses.delete(externalId)
      } else {
        await client.closeProfile(externalId)
        this.debugAddresses.delete(externalId)
      }
      this.deps.log.info(`${operation === 'open' ? 'Opened' : 'Closed'} profile ${externalId}`)

      // Confirm with IX Browser rather than assuming the request took effect.
      let confirmed = false
      try {
        const opened = await client.openedProfiles()
        const open = opened.api.includes(externalId) || (opened.client?.includes(externalId) ?? false)
        this.deps.profiles.setRunState(
          externalId,
          open ? 'running' : 'closed',
          open ? (opened.api.includes(externalId) ? 'api' : 'client') : null,
          new Date().toISOString()
        )
        confirmed = operation === 'open' ? open : !open
      } catch {
        this.deps.profiles.setRunState(externalId, 'unknown', null, new Date().toISOString())
      }
      this.emit([{ profileId: profile.id, externalId, kind: operation === 'open' ? 'opened' : 'closed', confirmed }])
      return { profile: this.deps.profiles.getByExternalId(externalId)!, confirmed }
    } catch (error) {
      const ix = error instanceof IxBrowserError ? error : new IxBrowserError('malformed', 'Request failed unexpectedly.', '')
      this.deps.log.warn(`Could not ${operation} profile ${externalId}: ${ix.message}`, { kind: ix.kind, code: ix.code })
      this.emit([{ profileId: profile.id, externalId, kind: operation === 'open' ? 'open-failed' : 'close-failed', message: ix.message }])
      throw ix
    } finally {
      this.pending.delete(externalId)
      this.deps.onChange()
    }
  }
}
