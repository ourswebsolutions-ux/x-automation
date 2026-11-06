import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import type { PinSetupResult, PinStatus, PinVerifyResult } from '@shared/types/security'
import { ConflictError, ValidationError } from '../errors'
import type { ScopedLogger } from '../logging/logger'

const derive = promisify(scrypt) as (secret: string, salt: Buffer, length: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>

/** Costly on purpose: a four-digit PIN has only 10,000 values. */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const HASH_BYTES = 32
const PIN_FORMAT = /^\d{4}$/
const RECOVERY_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const RECOVERY_LENGTH = 16

export const PIN_ATTEMPTS = 5
const FIRST_LOCKOUT_MS = 30_000
const MAX_LOCKOUT_MS = 15 * 60_000

interface Hashed {
  salt: string
  hash: string
}

interface PinFile {
  version: 1
  pin: Hashed
  recovery: Hashed
  /** Wrong attempts since the last success or lockout. */
  failures: number
  lockouts: number
  lockedUntil: number | null
}

async function hash(secret: string, salt = randomBytes(16)): Promise<Hashed> {
  const derived = await derive(secret, salt, HASH_BYTES, SCRYPT)
  return { salt: salt.toString('base64'), hash: derived.toString('base64') }
}

async function matches(secret: string, stored: Hashed): Promise<boolean> {
  const { hash: candidate } = await hash(secret, Buffer.from(stored.salt, 'base64'))
  return timingSafeEqual(Buffer.from(candidate, 'base64'), Buffer.from(stored.hash, 'base64'))
}

function newRecoveryCode(): string {
  const chars = Array.from({ length: RECOVERY_LENGTH }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)])
  return chars.join('').replace(/(.{4})(?=.)/g, '$1-')
}

const normalizeRecovery = (code: string) => code.toUpperCase().replace(/[^0-9A-Z]/g, '')

function requireFormat(pin: string): void {
  if (!PIN_FORMAT.test(pin)) throw new ValidationError('The PIN must be exactly 4 digits.')
}

interface Deps {
  filePath: string
  log: ScopedLogger
  now?: () => number
  /** Automated tests of other features only; never set in an installed app. */
  bypass?: boolean
}

/**
 * The app lock. Independent of the subscription: nothing here reads or affects it.
 *
 * It lives in its own file rather than SQLite so that a restored backup can't bring back an old
 * PIN, and "remove all stored keys" can't remove it. Only salted scrypt hashes are stored, and the
 * failure count is written before a wrong attempt is answered, so a restart doesn't reset it.
 */
export class PinService {
  private record: PinFile | null = null
  private unlocked: boolean
  /** One attempt at a time, so parallel guesses can't outrun the counter. */
  private queue: Promise<unknown> = Promise.resolve()
  private readonly now: () => number

  constructor(private readonly deps: Deps) {
    this.now = deps.now ?? Date.now
    this.unlocked = Boolean(deps.bypass)
    try {
      const parsed = JSON.parse(readFileSync(deps.filePath, 'utf8')) as Partial<PinFile>
      if (parsed.version === 1 && parsed.pin && parsed.recovery) this.record = parsed as PinFile
      else deps.log.warn('The PIN file was not recognised')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') deps.log.warn('The PIN file could not be read')
    }
  }

  get isUnlocked(): boolean {
    return this.unlocked
  }

  status(): PinStatus {
    const lockedUntil = this.record?.lockedUntil ?? null
    const locked = lockedUntil !== null && lockedUntil > this.now()
    return {
      configured: this.record !== null || Boolean(this.deps.bypass),
      unlocked: this.unlocked,
      retryAt: locked ? new Date(lockedUntil).toISOString() : null,
      attemptsLeft: locked ? 0 : PIN_ATTEMPTS - (this.record?.failures ?? 0)
    }
  }

  /** First run only. Setting a PIN unlocks this session. */
  setup(pin: string): Promise<PinSetupResult> {
    return this.serial(async () => {
      requireFormat(pin)
      if (this.record) throw new ConflictError('A PIN is already set.')
      const recoveryCode = newRecoveryCode()
      await this.store({ version: 1, pin: await hash(pin), recovery: await hash(normalizeRecovery(recoveryCode)), failures: 0, lockouts: 0, lockedUntil: null })
      this.unlocked = true
      this.deps.log.info('PIN set')
      return { recoveryCode, status: this.status() }
    })
  }

  verify(pin: string): Promise<PinVerifyResult> {
    return this.serial(async () => {
      requireFormat(pin)
      const record = this.record
      if (!record) throw new ConflictError('No PIN is set yet.')
      if (this.status().retryAt) return { ok: false, status: this.status() }
      if (!(await matches(pin, record.pin))) {
        await this.recordFailure(record)
        return { ok: false, status: this.status() }
      }
      await this.recordSuccess(record)
      this.unlocked = true
      return { ok: true, status: this.status() }
    })
  }

  /** Needs the current PIN even though the app is open: an unattended window isn't enough. */
  change(current: string, next: string): Promise<PinVerifyResult> {
    return this.serial(async () => {
      requireFormat(next)
      const record = this.record
      if (!record) throw new ConflictError('No PIN is set yet.')
      if (this.status().retryAt) return { ok: false, status: this.status() }
      if (!(await matches(current, record.pin))) {
        await this.recordFailure(record)
        return { ok: false, status: this.status() }
      }
      await this.store({ ...record, pin: await hash(next), failures: 0, lockouts: 0, lockedUntil: null })
      this.deps.log.info('PIN changed')
      return { ok: true, status: this.status() }
    })
  }

  /** Forgotten PIN. The code is replaced, so each one works once. Shares the attempt limit. */
  recover(code: string, next: string): Promise<PinSetupResult> {
    return this.serial(async () => {
      requireFormat(next)
      const record = this.record
      if (!record) throw new ConflictError('No PIN is set yet.')
      if (this.status().retryAt) throw new ValidationError('Too many wrong attempts. Wait, then try again.')
      if (!(await matches(normalizeRecovery(code), record.recovery))) {
        await this.recordFailure(record)
        throw new ValidationError('That recovery code is not correct.')
      }
      const recoveryCode = newRecoveryCode()
      await this.store({ ...record, pin: await hash(next), recovery: await hash(normalizeRecovery(recoveryCode)), failures: 0, lockouts: 0, lockedUntil: null })
      this.unlocked = true
      this.deps.log.info('PIN reset with a recovery code')
      return { recoveryCode, status: this.status() }
    })
  }

  private async recordFailure(record: PinFile): Promise<void> {
    const failures = record.failures + 1
    if (failures < PIN_ATTEMPTS) return this.store({ ...record, failures })
    const lockouts = record.lockouts + 1
    const delay = Math.min(FIRST_LOCKOUT_MS * 2 ** (lockouts - 1), MAX_LOCKOUT_MS)
    this.deps.log.warn(`Too many wrong PIN attempts; locked for ${Math.round(delay / 1000)} seconds`)
    await this.store({ ...record, failures: 0, lockouts, lockedUntil: this.now() + delay })
  }

  private async recordSuccess(record: PinFile): Promise<void> {
    if (record.failures || record.lockouts || record.lockedUntil !== null) await this.store({ ...record, failures: 0, lockouts: 0, lockedUntil: null })
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work)
    this.queue = run.catch(() => undefined)
    return run
  }

  private async store(next: PinFile): Promise<void> {
    await mkdir(dirname(this.deps.filePath), { recursive: true })
    const temp = `${this.deps.filePath}.tmp`
    await writeFile(temp, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 })
    await rename(temp, this.deps.filePath)
    this.record = next
  }
}
