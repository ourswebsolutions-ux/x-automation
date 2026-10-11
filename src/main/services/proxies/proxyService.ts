import { randomUUID } from 'node:crypto'
import type { BulkResult } from '@shared/types/accounts'
import type { Proxy, ProxyAssignment, ProxyImportResult, ProxyInput, ProxyTest } from '@shared/types/proxies'
import type { CredentialVault } from '../credentials/credentialVault'
import { CredentialUnavailableError } from '../credentials/credentialVault'
import type { SettingsRepository } from '../database/repositories'
import type { ProfileRepository } from '../database/sqlite/profileRepository'
import type { ProxyRepository, ProxyRow } from '../database/sqlite/proxyRepository'
import { ConflictError, NotFoundError, ValidationError } from '../errors'
import { IxBrowserError } from '../integrations/ixbrowser/client'
import type { IxBrowserService } from '../integrations/ixbrowser/ixBrowserService'
import type { ScopedLogger } from '../logging/logger'
import { parseProxyCsv, parseProxyLine, toCsv, toTxt, validHost, type ParsedProxy } from './proxyFormat'
import { DEFAULT_TEST_TARGET, testProxy, type TestTarget } from './proxyTester'

interface Deps {
  repo: ProxyRepository
  vault: CredentialVault
  settings: SettingsRepository
  profiles: ProfileRepository
  ixBrowser: IxBrowserService
  log: ScopedLogger
  onChange: () => void
  /** Swappable for tests. */
  testTarget?: TestTarget
}

const DEFAULT_KEY = 'proxy.defaultId'
const vaultKey = (id: string) => `proxy:${id}`
const MAX_IMPORT = 2000

/**
 * The proxy manager. Proxies are local records; passwords sit in the
 * OS-encrypted vault and are only read here, in the main process, to test a
 * proxy or hand it to IX Browser. Nothing rotates proxies automatically.
 */
export class ProxyService {
  private readonly testing = new Map<string, Promise<ProxyTest>>()

  constructor(private readonly deps: Deps) {}

  list(): Proxy[] {
    const defaultId = this.defaultId()
    return this.deps.repo.list().map((row) => this.view(row, defaultId))
  }

  get(id: string): Proxy {
    const row = this.deps.repo.get(id)
    if (!row) throw new NotFoundError('That proxy no longer exists.')
    return this.view(row, this.defaultId())
  }

  async create(input: ProxyInput): Promise<Proxy> {
    const clean = this.validate(input)
    if (this.deps.repo.findIdentity(clean.scheme, clean.host, clean.port, clean.username)) throw new ConflictError('That proxy (type, host, port and username) is already in the list.')
    const id = randomUUID()
    const at = new Date().toISOString()
    const password = typeof input.password === 'string' && input.password ? input.password : null
    if (password) await this.storePassword(id, password)
    this.deps.repo.insert({ id, ...clean, hasPassword: Boolean(password), createdAt: at, updatedAt: at })
    this.deps.log.info(`Added proxy "${clean.label}"`, { scheme: clean.scheme, auth: Boolean(clean.username) })
    this.deps.onChange()
    return this.get(id)
  }

  async update(id: string, input: ProxyInput): Promise<Proxy> {
    const existing = this.deps.repo.get(id)
    if (!existing) throw new NotFoundError('That proxy no longer exists.')
    const clean = this.validate(input)
    const clash = this.deps.repo.findIdentity(clean.scheme, clean.host, clean.port, clean.username)
    if (clash && clash.id !== id) throw new ConflictError('Another proxy already has that type, host, port and username.')
    let hasPassword = existing.hasPassword
    if (input.password === null) {
      await this.deps.vault.delete(vaultKey(id))
      hasPassword = false
    } else if (typeof input.password === 'string' && input.password) {
      await this.storePassword(id, input.password)
      hasPassword = true
    }
    const connectionChanged =
      clean.scheme !== existing.scheme || clean.host !== existing.host || clean.port !== existing.port || clean.username !== existing.username || input.password !== undefined
    this.deps.repo.update({ id, ...clean, hasPassword, updatedAt: new Date().toISOString() }, connectionChanged)
    this.deps.log.info(`Updated proxy "${clean.label}"`, { connectionChanged })
    this.deps.onChange()
    return this.get(id)
  }

  /** Refused while profiles use it — reassign or unassign them first. */
  async remove(id: string): Promise<void> {
    const row = this.deps.repo.get(id)
    if (!row) return
    if (row.assignedProfiles > 0) throw new ConflictError(`This proxy is assigned to ${row.assignedProfiles} profile${row.assignedProfiles === 1 ? '' : 's'}. Unassign it first.`)
    this.deps.repo.remove(id)
    await this.deps.vault.delete(vaultKey(id))
    if (this.defaultId() === id) this.deps.settings.delete(DEFAULT_KEY)
    this.deps.log.info(`Deleted proxy "${row.label}"`)
    this.deps.onChange()
  }

  setDefault(id: string | null): void {
    if (id && !this.deps.repo.get(id)) throw new NotFoundError('That proxy no longer exists.')
    if (id) this.deps.settings.set(DEFAULT_KEY, id)
    else this.deps.settings.delete(DEFAULT_KEY)
    this.deps.onChange()
  }

  /** A real connectivity test (one at a time per proxy). */
  test(id: string): Promise<ProxyTest> {
    const running = this.testing.get(id)
    if (running) return running
    const promise = this.runTest(id).finally(() => this.testing.delete(id))
    this.testing.set(id, promise)
    return promise
  }

  private async runTest(id: string): Promise<ProxyTest> {
    const row = this.deps.repo.get(id)
    if (!row) throw new NotFoundError('That proxy no longer exists.')
    const password = row.hasPassword ? this.deps.vault.get(vaultKey(id)) : null
    if (row.hasPassword && password === null) throw new ValidationError('The stored password for this proxy can’t be read on this device — enter it again.')
    const result = await testProxy({ scheme: row.scheme, host: row.host, port: row.port, username: row.username, password }, this.deps.testTarget ?? DEFAULT_TEST_TARGET)
    this.deps.repo.saveTest(id, result)
    if (result.ok) this.deps.log.info(`Proxy "${row.label}" passed its test`, { latencyMs: result.latencyMs, verified: result.verified })
    else this.deps.log.warn(`Proxy "${row.label}" failed its test: ${result.error}`)
    this.deps.onChange()
    return result
  }

  /** Imports TXT (one proxy per line) or CSV with a header row. Duplicates are skipped. */
  async import(text: string, format: 'txt' | 'csv', defaultScheme: ProxyInput['scheme'] = 'http'): Promise<ProxyImportResult> {
    const rows =
      format === 'csv'
        ? parseProxyCsv(text)
        : text
            .split(/\r?\n/)
            .map((line, i) => ({ line: i + 1, raw: line }))
            .filter((l) => l.raw.trim() && !l.raw.trim().startsWith('#'))
            .map((l) => ({ line: l.line, result: parseProxyLine(l.raw, defaultScheme) }))
    if (rows.length > MAX_IMPORT) throw new ValidationError(`Import up to ${MAX_IMPORT} proxies at a time.`)
    const result: ProxyImportResult = { added: 0, duplicates: 0, rejected: [], cancelled: false }
    for (const { line, result: parsed } of rows) {
      if (typeof parsed === 'string') {
        result.rejected.push({ line, reason: parsed })
        continue
      }
      if (this.deps.repo.findIdentity(parsed.scheme, parsed.host, parsed.port, parsed.username)) {
        result.duplicates++
        continue
      }
      try {
        await this.create(this.fromParsed(parsed))
        result.added++
      } catch (error) {
        result.rejected.push({ line, reason: error instanceof Error ? error.message : 'Could not add.' })
      }
    }
    this.deps.log.info(`Imported proxies (${format})`, { added: result.added, duplicates: result.duplicates, rejected: result.rejected.length })
    return result
  }

  /** Exports connection details. Passwords are never written to export files. */
  export(format: 'txt' | 'csv'): { text: string; count: number } {
    const rows = this.deps.repo.list()
    return { text: format === 'csv' ? toCsv(rows) : toTxt(rows), count: rows.length }
  }

  assignments(): ProxyAssignment[] {
    return this.deps.repo.assignments()
  }

  /**
   * Applies a proxy to closed, available IX Browser profiles through the
   * documented profile-update-proxy-for-custom-proxy action. Each profile is
   * recorded as applied or failed with IX Browser's answer; nothing is retried
   * automatically.
   */
  async assign(profileIds: string[], proxyId: string): Promise<BulkResult> {
    const proxy = this.deps.repo.get(proxyId)
    if (!proxy) throw new NotFoundError('That proxy no longer exists.')
    if (!proxy.enabled) throw new ValidationError('That proxy is disabled. Enable it before assigning it.')
    const password = proxy.hasPassword ? this.deps.vault.get(vaultKey(proxyId)) : null
    if (proxy.hasPassword && password === null) throw new ValidationError('The stored password for this proxy can’t be read on this device — enter it again.')
    const result: BulkResult = { changed: 0, skipped: [] }
    for (const profileId of [...new Set(profileIds)]) {
      const profile = this.deps.profiles.get(profileId)
      if (!profile) {
        result.skipped.push({ id: profileId, reason: 'Profile not found — sync profiles again.' })
        continue
      }
      const at = new Date().toISOString()
      try {
        await this.deps.ixBrowser.applyCustomProxy(profile.externalId, { scheme: proxy.scheme, host: proxy.host, port: proxy.port, username: proxy.username, password })
        this.deps.repo.upsertAssignment(profileId, proxyId, 'applied', null, at)
        result.changed++
      } catch (error) {
        const message = error instanceof Error ? error.message : 'IX Browser did not accept the proxy.'
        // IX errors carry the why (e.g. proxies apply when a profile starts) in their hint.
        const reason = error instanceof IxBrowserError && error.hint ? `${message} ${error.hint}` : message
        // Only record a failed attempt for profiles IX Browser actually reported on.
        if (!/not running|is open|close it|not in the local list|no longer reported|not configured|connection is set up/i.test(message)) {
          this.deps.repo.upsertAssignment(profileId, proxyId, 'failed', reason.slice(0, 300), at)
        }
        result.skipped.push({ id: profileId, reason })
      }
    }
    this.deps.log.info(`Assigned proxy "${proxy.label}"`, { applied: result.changed, skipped: result.skipped.length })
    this.deps.onChange()
    return result
  }

  /** Removes the local assignment only — the profile keeps its proxy setting in IX Browser. */
  unassign(profileIds: string[]): BulkResult {
    const result: BulkResult = { changed: 0, skipped: [] }
    for (const id of new Set(profileIds)) {
      if (this.deps.repo.removeAssignment(id)) result.changed++
      else result.skipped.push({ id, reason: 'No proxy assigned.' })
    }
    if (result.changed) this.deps.onChange()
    return result
  }

  /** Applies the default proxy to available, closed profiles that have no assignment yet. */
  async applyDefault(): Promise<BulkResult> {
    const id = this.defaultId()
    if (!id) throw new ValidationError('Choose a default proxy first.')
    const targets = this.deps.profiles
      .list()
      .filter((p) => p.availability === 'available' && !this.deps.repo.assignmentFor(p.id))
      .map((p) => p.id)
    if (!targets.length) return { changed: 0, skipped: [] }
    return this.assign(targets, id)
  }

  // ── internals ────────────────────────────────────────────────────────────

  private defaultId(): string | null {
    return this.deps.settings.get<string>(DEFAULT_KEY) ?? null
  }

  private async storePassword(id: string, password: string): Promise<void> {
    if (password.length > 255) throw new ValidationError('Proxy passwords can be up to 255 characters.')
    if (!this.deps.vault.status().secure) throw new CredentialUnavailableError('Secure credential storage is not available on this system, so the proxy password was not saved.')
    await this.deps.vault.set(vaultKey(id), password)
  }

  private validate(input: ProxyInput): Omit<ProxyRow, 'id' | 'hasPassword' | 'lastTest' | 'assignedProfiles' | 'createdAt' | 'updatedAt'> {
    const host = input.host.trim().replace(/^\[|\]$/g, '')
    if (!validHost(host)) throw new ValidationError('Enter a valid host name or IP address.')
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new ValidationError('Port must be between 1 and 65535.')
    const username = input.username?.trim() || null
    if (username && username.length > 255) throw new ValidationError('Usernames can be up to 255 characters.')
    if (/[\r\n]/.test(username ?? '')) throw new ValidationError('Usernames cannot contain line breaks.')
    const label = input.label.trim() || `${input.scheme}://${host}:${input.port}`
    if (label.length > 80) throw new ValidationError('Labels can be up to 80 characters.')
    return { label, scheme: input.scheme, host, port: input.port, username, enabled: input.enabled, notes: input.notes.trim().slice(0, 1000) }
  }

  private fromParsed(p: ParsedProxy): ProxyInput {
    return { label: p.label ?? '', scheme: p.scheme, host: p.host, port: p.port, username: p.username, password: p.password, enabled: true, notes: p.notes }
  }

  private view(row: ProxyRow, defaultId: string | null): Proxy {
    return {
      ...row,
      passwordMissing: row.hasPassword && !this.deps.vault.has(vaultKey(row.id)),
      isDefault: row.id === defaultId
    }
  }
}
