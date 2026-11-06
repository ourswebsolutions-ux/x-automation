import { createPublicKey, verify, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { SUBSCRIPTION_REFRESH_MS } from '@shared/config/activation'
import { PLAN_IDS, type OtpRequestResult, type PlanId, type SubscriptionPlan, type SubscriptionState, type SubscriptionStatus } from '@shared/types/security'
import { ValidationError } from '../errors'
import type { ScopedLogger } from '../logging/logger'
import type { DeviceIdentity } from './deviceIdentity'

const REQUEST_TIMEOUT_MS = 20_000
const TICK_MS = 60_000
const SEEN_WRITE_MS = 60 * 60_000
/** Clocks drift; only a larger jump backwards counts as winding the clock back. */
const CLOCK_TOLERANCE_MS = 60 * 60_000

export class ActivationUnavailableError extends Error {
  constructor(message = 'The activation service can’t be reached. Check your connection and try again.') {
    super(message)
    this.name = 'ActivationUnavailableError'
  }
}

const planId = z.enum(PLAN_IDS)
const planSchema = z.object({ id: planId, name: z.string(), price: z.string(), currency: z.string(), durationLabel: z.string() })
const plansResponse = z.object({ plans: z.array(planSchema) })
const otpResponse = z.object({ expiresAt: z.string() })
const statusResponse = z.object({
  state: z.enum(['none', 'active', 'expired', 'revoked']),
  plan: planId.nullable(),
  expiresAt: z.string().nullable(),
  token: z.string().nullable()
})
const errorResponse = z.object({ error: z.object({ code: z.string(), message: z.string() }) })
const claimsSchema = z.object({
  v: z.literal(1),
  activationId: z.string(),
  plan: planId,
  expiresAt: z.string().nullable(),
  issuedAt: z.string(),
  leaseUntil: z.string()
})
type Claims = z.infer<typeof claimsSchema>

interface StoredState {
  version: 1
  /** Signed by the server, so this file needs no secrecy and can't be edited into an upgrade. */
  token: string | null
  /** The last answer from the server, kept to explain why access ended. */
  state: SubscriptionState
  plan: PlanId | null
  expiresAt: string | null
  lastCheckedAt: string | null
  /** Latest time this device has seen, to notice the clock being wound back. */
  lastSeenAt: number
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

interface Deps {
  filePath: string
  identity: DeviceIdentity
  /** Base64 SPKI Ed25519 key. */
  publicKey: string
  /** null when this build has no activation server. */
  baseUrl: string | null
  fetch: FetchLike
  log: ScopedLogger
  onChange: () => void
  now?: () => number
  /** Automated tests of other features only; never set in an installed app. */
  bypass?: boolean
}

/**
 * The device's side of the subscription. Independent of the PIN: nothing here reads or affects it.
 *
 * The app holds no prices, keys or OTP logic. It holds a lease signed by the server, checked with
 * the public key on every use; a lease lasts days and is renewed while online, so a device keeps
 * working through an outage but a revocation still reaches it.
 */
export class SubscriptionService {
  private stored: StoredState
  private readonly key: KeyObject
  private readonly now: () => number
  private lastActive = false
  private timers: NodeJS.Timeout[] = []

  constructor(private readonly deps: Deps) {
    this.now = deps.now ?? Date.now
    this.key = createPublicKey({ key: Buffer.from(deps.publicKey, 'base64'), format: 'der', type: 'spki' })
    this.stored = this.read()
    this.lastActive = this.isActive
  }

  get isActive(): boolean {
    return Boolean(this.deps.bypass) || this.validClaims() !== null
  }

  status(): SubscriptionStatus {
    const base = { activationId: this.deps.identity.activationId, lastCheckedAt: this.stored.lastCheckedAt, serviceConfigured: this.deps.baseUrl !== null }
    if (this.deps.bypass) return { ...base, state: 'active', plan: 'lifetime', expiresAt: null }
    const claims = this.validClaims()
    if (claims) return { ...base, state: 'active', plan: claims.plan, expiresAt: claims.expiresAt }
    const lapsed = this.stored.expiresAt !== null && new Date(this.stored.expiresAt).getTime() <= this.now()
    const state: SubscriptionState = this.stored.state !== 'active' ? this.stored.state : lapsed ? 'expired' : 'stale'
    return { ...base, state, plan: this.stored.plan, expiresAt: this.stored.expiresAt }
  }

  /** Checks with the server at once, then keeps checking. */
  start(): void {
    this.stop()
    if (this.deps.bypass) return
    void this.refresh().catch(() => undefined)
    this.timers = [
      setInterval(() => void this.refresh().catch(() => undefined), SUBSCRIPTION_REFRESH_MS),
      setInterval(() => this.tick(), TICK_MS)
    ]
    for (const timer of this.timers) timer.unref()
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
  }

  async plans(): Promise<SubscriptionPlan[]> {
    return plansResponse.parse(await this.call('GET', '/v1/plans')).plans
  }

  /** Asks the server to email the administrator a code. The app never sees that code. */
  async requestOtp(plan: PlanId): Promise<OtpRequestResult> {
    const body = await this.call('POST', '/v1/activation/request', { ...this.deps.identity, plan })
    this.deps.log.info(`Activation code requested for the ${plan} plan`)
    return otpResponse.parse(body)
  }

  async verifyOtp(plan: PlanId, otp: string): Promise<SubscriptionStatus> {
    const body = await this.call('POST', '/v1/activation/verify', { ...this.deps.identity, plan, otp })
    await this.apply(statusResponse.parse(body))
    if (!this.isActive) throw new ActivationUnavailableError('The activation could not be confirmed. Update X Auto, or contact the administrator.')
    this.deps.log.success('Subscription activated')
    return this.status()
  }

  /** Quiet when offline: the current lease simply stays in force. */
  async refresh(): Promise<SubscriptionStatus> {
    if (this.deps.bypass) return this.status()
    try {
      await this.apply(statusResponse.parse(await this.call('POST', '/v1/subscription/status', this.deps.identity)))
    } catch (error) {
      if (!(error instanceof ValidationError)) {
        this.deps.log.warn('The subscription could not be checked; keeping the current state')
        return this.status()
      }
      // The server answered and refused this device.
      await this.apply({ state: 'none', plan: null, expiresAt: null, token: null })
    }
    return this.status()
  }

  private async apply(answer: z.infer<typeof statusResponse>): Promise<void> {
    await this.save({
      ...this.stored,
      token: answer.state === 'active' ? answer.token : null,
      state: answer.state,
      plan: answer.plan,
      expiresAt: answer.expiresAt,
      lastCheckedAt: new Date(this.now()).toISOString(),
      // A real answer settles any doubt about this clock.
      lastSeenAt: this.now()
    })
    this.announce()
  }

  private tick(): void {
    const now = this.now()
    if (now - this.stored.lastSeenAt >= SEEN_WRITE_MS) void this.save({ ...this.stored, lastSeenAt: now }).catch(() => undefined)
    if (this.isActive !== this.lastActive) this.announce()
  }

  /** Leases run out on their own, so this notices the moment access ends. */
  private announce(): void {
    const active = this.isActive
    if (active !== this.lastActive) this.deps.log.info(active ? 'Subscription active' : 'Subscription no longer active')
    this.lastActive = active
    this.deps.onChange()
  }

  private validClaims(): Claims | null {
    const token = this.stored.token
    if (!token) return null
    const [payload, signature] = token.split('.')
    if (!payload || !signature) return null
    const bytes = Buffer.from(payload, 'base64url')
    if (!verify(null, bytes, this.key, Buffer.from(signature, 'base64url'))) return null
    let claims: Claims
    try {
      claims = claimsSchema.parse(JSON.parse(bytes.toString('utf8')))
    } catch {
      return null
    }
    const now = this.now()
    if (claims.activationId !== this.deps.identity.activationId) return null
    if (now >= new Date(claims.leaseUntil).getTime()) return null
    // A clock wound back can't revive an old lease. This compares the device with itself on
    // purpose: a PC whose clock simply disagrees with the server's must still be able to activate.
    if (now < this.stored.lastSeenAt - CLOCK_TOLERANCE_MS) return null
    return claims
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    if (!this.deps.baseUrl) throw new ActivationUnavailableError('Activation isn’t set up in this build of X Auto.')
    let response: Response
    try {
      response = await this.deps.fetch(`${this.deps.baseUrl}${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
    } catch {
      throw new ActivationUnavailableError()
    }
    const json: unknown = await response.json().catch(() => null)
    if (response.ok) return json
    const failure = errorResponse.safeParse(json)
    if (!failure.success) throw new ActivationUnavailableError()
    // Server messages are written for customers. A 5xx with one still means "try again".
    if (response.status >= 500) throw new ActivationUnavailableError(failure.data.error.message)
    if (response.status === 429) throw new ActivationUnavailableError(failure.data.error.message)
    throw new ValidationError(failure.data.error.message)
  }

  private read(): StoredState {
    const blank: StoredState = { version: 1, token: null, state: 'none', plan: null, expiresAt: null, lastCheckedAt: null, lastSeenAt: this.now() }
    try {
      const parsed = JSON.parse(readFileSync(this.deps.filePath, 'utf8')) as Partial<StoredState>
      return parsed.version === 1 ? { ...blank, ...parsed } : blank
    } catch {
      return blank
    }
  }

  private async save(next: StoredState): Promise<void> {
    this.stored = next
    await mkdir(dirname(this.deps.filePath), { recursive: true })
    const temp = `${this.deps.filePath}.tmp`
    await writeFile(temp, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 })
    await rename(temp, this.deps.filePath)
  }
}
