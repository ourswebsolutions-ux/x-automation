import { createHash, createHmac, randomInt, sign, timingSafeEqual } from 'node:crypto'
import { transaction } from './db.mjs'

export const OTP_TTL_MS = 10 * 60_000
/** A Lifetime activation code has to end somewhere; this is far beyond any install. */
const OFFLINE_LIFETIME_UNTIL = Date.UTC(2100, 0, 1)
export const OTP_MAX_ATTEMPTS = 5
export const OTP_COOLDOWN_MS = 60_000
const HOUR = 3_600_000

const ACTIVATION_ID = /^XA-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/
const DEVICE_KEY = /^[0-9a-f]{64}$/
const OTP = /^\d{6}$/

/** Fixed-window limits. Stored in the database so a restart doesn't reset them. */
const LIMITS = {
  requestIp: { max: 10, windowMs: HOUR },
  requestDevice: { max: 5, windowMs: HOUR },
  requestGlobal: { max: 100, windowMs: HOUR },
  verifyIp: { max: 30, windowMs: 10 * 60_000 },
  verifyDevice: { max: 15, windowMs: 10 * 60_000 },
  statusIp: { max: 300, windowMs: HOUR }
}

export class ActivationError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

const fail = {
  input: (what) => new ActivationError(400, 'invalid_request', `Invalid ${what}.`),
  planUnavailable: () => new ActivationError(400, 'plan_unavailable', 'That plan is not available.'),
  otpInvalid: () => new ActivationError(400, 'otp_invalid', 'That code is not correct.'),
  otpExpired: () => new ActivationError(400, 'otp_expired', 'That code has expired. Request a new one.'),
  otpUsed: () => new ActivationError(400, 'otp_used', 'That code has already been used.'),
  otpLocked: () => new ActivationError(400, 'otp_locked', 'Too many wrong attempts. Request a new code.'),
  device: () => new ActivationError(403, 'device_mismatch', 'This Activation ID belongs to another device.'),
  revoked: () => new ActivationError(403, 'revoked', 'This subscription was revoked. Contact the administrator.'),
  lifetime: () => new ActivationError(409, 'already_lifetime', 'This device already has a Lifetime subscription.'),
  cooldown: () => new ActivationError(429, 'cooldown', 'A code was requested moments ago. Please wait a minute.'),
  rate: () => new ActivationError(429, 'rate_limited', 'Too many requests. Please try again later.'),
  email: () => new ActivationError(502, 'email_failed', 'The activation email could not be sent. Please try again.')
}

/** Adds calendar months, keeping the end of the month (31 Aug + 6 months = 28 Feb, not 3 Mar). */
export function addMonths(ms, months) {
  const date = new Date(ms)
  const day = date.getUTCDate()
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() + months)
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
  date.setUTCDate(Math.min(day, lastDay))
  return date.getTime()
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString())

export class ActivationService {
  constructor({ db, config, mailer, now = Date.now }) {
    this.db = db
    this.config = config
    this.mailer = mailer
    this.now = now
  }

  plans() {
    return this.config.plans.map(({ id, name, price, currency, durationLabel }) => ({ id, name, price, currency, durationLabel }))
  }

  /** Step 1: creates the OTP and emails it to the administrator. The customer never receives it. */
  async requestOtp({ activationId, deviceKey, plan, ip }) {
    this.#identity(activationId, deviceKey)
    const planConfig = this.#plan(plan)
    this.#limit(`request:ip:${ip}`, LIMITS.requestIp)
    this.#limit(`request:device:${activationId}`, LIMITS.requestDevice)
    this.#limit('request:global', LIMITS.requestGlobal)
    this.#bindDevice(activationId, deviceKey)

    const subscription = this.#subscription(activationId)
    if (subscription?.status === 'revoked') throw fail.revoked()
    if (subscription?.status === 'active' && subscription.expires_at === null) throw fail.lifetime()

    const now = this.now()
    const latest = this.db.prepare('SELECT created_at FROM otps WHERE activation_id = ? ORDER BY id DESC LIMIT 1').get(activationId)
    if (latest && now - latest.created_at < OTP_COOLDOWN_MS) throw fail.cooldown()

    const otp = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const expiresAt = now + OTP_TTL_MS
    const otpId = transaction(this.db, () => {
      // One live code per device: a new request cancels the previous one.
      this.db.prepare('UPDATE otps SET invalidated_at = ? WHERE activation_id = ? AND used_at IS NULL AND invalidated_at IS NULL').run(now, activationId)
      const { lastInsertRowid } = this.db
        .prepare('INSERT INTO otps (activation_id, plan, otp_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(activationId, plan, this.#otpHash(activationId, plan, otp), now, expiresAt)
      return lastInsertRowid
    })

    try {
      await this.mailer.sendOtp({
        activationId,
        planName: planConfig.name,
        priceLabel: `${planConfig.currency} ${planConfig.price}`,
        otp,
        expiresAt: new Date(expiresAt)
      })
    } catch (error) {
      this.db.prepare('UPDATE otps SET invalidated_at = ? WHERE id = ?').run(this.now(), otpId)
      this.#log('otp_email_failed', activationId, plan, ip, error?.code ?? 'smtp error')
      throw fail.email()
    }
    this.#log('otp_requested', activationId, plan, ip)
    return { expiresAt: iso(expiresAt) }
  }

  /** Step 2: checks the code against its device and plan, then activates, all or nothing. */
  verifyOtp({ activationId, deviceKey, plan, otp, ip }) {
    this.#identity(activationId, deviceKey)
    if (typeof otp !== 'string' || !OTP.test(otp)) throw fail.input('code')
    const planConfig = this.#plan(plan)
    this.#limit(`verify:ip:${ip}`, LIMITS.verifyIp)
    this.#limit(`verify:device:${activationId}`, LIMITS.verifyDevice)
    if (!this.#deviceMatches(activationId, deviceKey)) {
      this.#log('verify_rejected', activationId, plan, ip, 'device')
      throw this.#device(activationId) ? fail.device() : fail.otpInvalid()
    }

    const now = this.now()
    let rejection = null
    const refuse = (error) => {
      rejection = error
    }
    // A rejected attempt must still commit (it counts against the code), so nothing throws inside.
    transaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM otps WHERE activation_id = ? ORDER BY id DESC LIMIT 1').get(activationId)
      if (!row || row.invalidated_at !== null) return refuse(fail.otpInvalid())
      if (row.used_at !== null) return refuse(fail.otpUsed())
      if (now >= row.expires_at) return refuse(fail.otpExpired())
      if (row.attempts >= OTP_MAX_ATTEMPTS) return refuse(fail.otpLocked())

      // The hash covers the Activation ID and plan, so a code for another plan cannot match.
      const expected = Buffer.from(row.otp_hash, 'hex')
      const actual = Buffer.from(this.#otpHash(activationId, plan, otp), 'hex')
      if (!timingSafeEqual(expected, actual)) {
        this.db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE id = ?').run(row.id)
        return refuse(fail.otpInvalid())
      }

      const existing = this.#subscription(activationId)
      if (existing?.status === 'revoked') return refuse(fail.revoked())
      if (this.db.prepare('UPDATE otps SET used_at = ? WHERE id = ? AND used_at IS NULL').run(now, row.id).changes !== 1) return refuse(fail.otpUsed())

      this.#activate(activationId, planConfig, existing, now)
      this.#log('activated', activationId, plan, ip)
    })
    if (rejection) {
      this.#log('verify_rejected', activationId, plan, ip, rejection.code)
      throw rejection
    }
    return this.#view(activationId)
  }

  /** Called on start and periodically: renews the lease and reports revocation or expiry. */
  status({ activationId, deviceKey, ip }) {
    this.#identity(activationId, deviceKey)
    this.#limit(`status:ip:${ip}`, LIMITS.statusIp)
    const device = this.#device(activationId)
    if (device && !this.#deviceMatches(activationId, deviceKey)) throw fail.device()
    if (device) this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE activation_id = ?').run(this.now(), activationId)
    return device ? this.#view(activationId) : { state: 'none', plan: null, expiresAt: null, token: null }
  }

  // ── Administrator operations (server console only, see admin.mjs) ──

  revoke(activationId, reason = '') {
    const now = this.now()
    const { changes } = this.db
      .prepare("UPDATE subscriptions SET status = 'revoked', revoked_at = ?, revoke_reason = ?, updated_at = ? WHERE activation_id = ?")
      .run(now, reason, now, activationId)
    if (!changes) throw new ActivationError(404, 'not_found', 'No subscription for that Activation ID.')
    this.#log('revoked', activationId, null, 'admin', reason)
  }

  reinstate(activationId) {
    const subscription = this.#subscription(activationId)
    if (!subscription) throw new ActivationError(404, 'not_found', 'No subscription for that Activation ID.')
    const now = this.now()
    const status = subscription.expires_at !== null && subscription.expires_at <= now ? 'expired' : 'active'
    this.db.prepare('UPDATE subscriptions SET status = ?, revoked_at = NULL, revoke_reason = NULL, updated_at = ? WHERE activation_id = ?').run(status, now, activationId)
    this.#log('reinstated', activationId, subscription.plan, 'admin')
    return status
  }

  /** Reactivation on a replacement device: the subscription moves, it isn't copied. */
  transfer(fromId, toId) {
    if (!ACTIVATION_ID.test(toId ?? '')) throw fail.input('Activation ID')
    transaction(this.db, () => {
      const subscription = this.#subscription(fromId)
      if (!subscription) throw new ActivationError(404, 'not_found', 'No subscription for the old Activation ID.')
      if (subscription.status === 'revoked') throw fail.revoked()
      if (this.#subscription(toId)) throw new ActivationError(409, 'target_has_subscription', 'The new Activation ID already has a subscription.')
      this.db.prepare('UPDATE subscriptions SET activation_id = ?, updated_at = ? WHERE activation_id = ?').run(toId, this.now(), fromId)
      this.db.prepare('UPDATE otps SET invalidated_at = ? WHERE activation_id = ? AND used_at IS NULL AND invalidated_at IS NULL').run(this.now(), fromId)
      this.#log('transferred', fromId, subscription.plan, 'admin', `to ${toId}`)
    })
  }

  /**
   * Activation without a server: a code the administrator gives the customer, who pastes it into the
   * app. It is a lease signed with the private key that lasts as long as the subscription, so the app
   * checks it offline. `renew` adds a plan's time, as a paid activation does; `reissue` gives the
   * current subscription's code again (a reinstall, a lost message) without adding time.
   */
  issueCode(activationId, planId, { renew = true } = {}) {
    if (!ACTIVATION_ID.test(activationId ?? '')) throw fail.input('Activation ID')
    const now = this.now()
    return transaction(this.db, () => {
      const existing = this.#subscription(activationId)
      if (existing?.status === 'revoked') throw fail.revoked()
      if (renew) {
        const durations = this.config.durations ?? { monthly: { days: 30 }, six_months: { months: 6 }, lifetime: null }
        if (!(planId in durations)) throw fail.planUnavailable()
        const lifetimeNow = existing?.status === 'active' && existing.expires_at === null
        if (lifetimeNow && planId !== 'lifetime') throw fail.lifetime()
        if (!lifetimeNow) this.#activate(activationId, { id: planId, duration: durations[planId] }, existing, now)
        this.#log('code_issued', activationId, planId, 'admin')
      } else {
        if (!existing) throw new ActivationError(404, 'not_found', 'No subscription for that Activation ID.')
        this.#log('code_reissued', activationId, existing.plan, 'admin')
      }
      const subscription = this.#view(activationId)
      if (subscription.state !== 'active') throw new ActivationError(409, 'not_active', `That subscription is ${subscription.state}.`)
      const record = this.#subscription(activationId)
      return { plan: record.plan, expiresAt: subscription.expiresAt, code: this.#token(record, now, record.expires_at ?? OFFLINE_LIFETIME_UNTIL) }
    })
  }

  /** Staging only: returns a device to "never activated" so the test can be repeated. */
  resetForTesting(activationId) {
    if (!this.config.staging) throw new ActivationError(403, 'staging_only', 'reset works only with STAGING=1.')
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM subscriptions WHERE activation_id = ?').run(activationId)
      this.db.prepare('DELETE FROM otps WHERE activation_id = ?').run(activationId)
      this.db.prepare('DELETE FROM rate_limits WHERE key LIKE ?').run(`%:device:${activationId}`)
      this.#log('reset_for_testing', activationId, null, 'admin')
    })
  }

  listSubscriptions() {
    return this.db.prepare('SELECT * FROM subscriptions ORDER BY updated_at DESC').all()
  }

  logs(activationId, limit = 50) {
    return activationId
      ? this.db.prepare('SELECT * FROM activation_logs WHERE activation_id = ? ORDER BY id DESC LIMIT ?').all(activationId, limit)
      : this.db.prepare('SELECT * FROM activation_logs ORDER BY id DESC LIMIT ?').all(limit)
  }

  // ── Internals ──

  #identity(activationId, deviceKey) {
    if (typeof activationId !== 'string' || !ACTIVATION_ID.test(activationId)) throw fail.input('Activation ID')
    if (typeof deviceKey !== 'string' || !DEVICE_KEY.test(deviceKey)) throw fail.input('device')
  }

  #plan(id) {
    const plan = this.config.plans.find((candidate) => candidate.id === id)
    if (!plan) throw fail.planUnavailable()
    return plan
  }

  #otpHash(activationId, plan, otp) {
    return createHmac('sha256', this.config.otpPepper).update(`${activationId}|${plan}|${otp}`).digest('hex')
  }

  #limit(key, { max, windowMs }) {
    const now = this.now()
    const row = this.db.prepare('SELECT window_start, count FROM rate_limits WHERE key = ?').get(key)
    if (!row || now - row.window_start >= windowMs) {
      this.db.prepare('INSERT OR REPLACE INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)').run(key, now)
      return
    }
    if (row.count >= max) {
      this.#log('rate_limited', null, null, null, key)
      throw fail.rate()
    }
    this.db.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').run(key)
  }

  #device(activationId) {
    return this.db.prepare('SELECT device_key_hash FROM devices WHERE activation_id = ?').get(activationId)
  }

  #deviceMatches(activationId, deviceKey) {
    const device = this.#device(activationId)
    if (!device) return false
    return timingSafeEqual(Buffer.from(device.device_key_hash, 'hex'), Buffer.from(sha256(deviceKey), 'hex'))
  }

  /** The first request ties the Activation ID to the device's private key; later ones must match. */
  #bindDevice(activationId, deviceKey) {
    const device = this.#device(activationId)
    if (device && !this.#deviceMatches(activationId, deviceKey)) throw fail.device()
    const now = this.now()
    if (device) this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE activation_id = ?').run(now, activationId)
    else this.db.prepare('INSERT INTO devices (activation_id, device_key_hash, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)').run(activationId, sha256(deviceKey), now, now)
  }

  #subscription(activationId) {
    return this.db.prepare('SELECT * FROM subscriptions WHERE activation_id = ?').get(activationId)
  }

  /** Renewing early adds to the remaining time rather than discarding it. */
  #activate(activationId, plan, existing, now) {
    const stillRunning = existing?.status === 'active' && existing.expires_at !== null && existing.expires_at > now
    const start = stillRunning ? existing.expires_at : now
    let expiresAt = null
    if (plan.duration?.days) expiresAt = start + plan.duration.days * 86_400_000
    if (plan.duration?.months) expiresAt = addMonths(start, plan.duration.months)
    this.db
      .prepare(
        `INSERT INTO subscriptions (activation_id, plan, status, activated_at, expires_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?)
         ON CONFLICT (activation_id) DO UPDATE SET plan = excluded.plan, status = 'active', activated_at = excluded.activated_at,
           expires_at = excluded.expires_at, updated_at = excluded.updated_at`
      )
      .run(activationId, plan.id, now, expiresAt, now)
  }

  #view(activationId) {
    const subscription = this.#subscription(activationId)
    if (!subscription) return { state: 'none', plan: null, expiresAt: null, token: null }
    const now = this.now()
    if (subscription.status === 'active' && subscription.expires_at !== null && subscription.expires_at <= now) {
      this.db.prepare("UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE activation_id = ?").run(now, activationId)
      this.#log('expired', activationId, subscription.plan, null)
      subscription.status = 'expired'
    }
    return {
      state: subscription.status,
      plan: subscription.plan,
      expiresAt: iso(subscription.expires_at),
      token: subscription.status === 'active' ? this.#token(subscription, now) : null
    }
  }

  /** A signed lease. It never outlives the subscription, so expiry needs no further check on the device. */
  #token(subscription, now, leaseUntil = null) {
    const lease = leaseUntil ?? now + this.config.leaseMs
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        activationId: subscription.activation_id,
        plan: subscription.plan,
        expiresAt: iso(subscription.expires_at),
        issuedAt: iso(now),
        leaseUntil: iso(subscription.expires_at === null ? lease : Math.min(lease, subscription.expires_at))
      })
    )
    return `${payload.toString('base64url')}.${sign(null, payload, this.config.privateKey).toString('base64url')}`
  }

  #log(event, activationId, plan, ip, detail = null) {
    this.db.prepare('INSERT INTO activation_logs (at, event, activation_id, plan, ip, detail) VALUES (?, ?, ?, ?, ?, ?)').run(this.now(), event, activationId, plan, ip, detail)
  }
}
