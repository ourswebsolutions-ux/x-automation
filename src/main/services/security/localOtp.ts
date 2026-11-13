import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import nodemailer from 'nodemailer'
import { PLAN_NAMES, type OtpRequestResult, type PlanId, type SubscriptionPlan } from '@shared/types/security'
import { ValidationError } from '../errors'
import type { ScopedLogger } from '../logging/logger'
import type { DeviceIdentity } from './deviceIdentity'

export const OTP_TTL_MS = 10 * 60_000
export const OTP_MAX_ATTEMPTS = 5
export const OTP_COOLDOWN_MS = 60_000
const REQUESTS_PER_HOUR = 5

/** Calendar months, keeping the end of the month (31 Aug + 6 months = 28 Feb). */
export function addMonths(ms: number, months: number): number {
  const date = new Date(ms)
  const day = date.getUTCDate()
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() + months)
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
  date.setUTCDate(Math.min(day, lastDay))
  return date.getTime()
}

const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>".]+(\.[^\s@,;<>".]+)+$/

/**
 * Everything sensitive comes from environment variables on this PC, read by the main process only.
 * Nothing here is part of the app's files, its installer or its window.
 */
export interface LocalOtpConfig {
  smtp: { host: string; port: number; secure: boolean; user: string; pass: string }
  /** The address that sends (the SMTP account). */
  from: string
  /** The only address that ever receives an OTP. */
  adminEmail: string
  currency: string
  prices: Partial<Record<PlanId, string>>
  monthlyDays: number
}

/** null when email OTP isn't set up on this PC (then activation codes are offered instead). */
export function readLocalOtpConfig(env: NodeJS.ProcessEnv): LocalOtpConfig | null {
  const value = (name: string) => env[name]?.trim() ?? ''
  const user = value('XAUTO_SMTP_USER')
  const pass = value('XAUTO_SMTP_PASS').replace(/\s+/g, '')
  const adminEmail = value('XAUTO_ADMIN_EMAIL')
  if (!user || !pass || !EMAIL.test(adminEmail)) return null
  const port = Number(value('XAUTO_SMTP_PORT') || 465)
  const days = Number(value('XAUTO_PLAN_MONTHLY_DAYS') || 30)
  return {
    smtp: {
      host: value('XAUTO_SMTP_HOST') || 'smtp.gmail.com',
      port: Number.isInteger(port) && port > 0 ? port : 465,
      secure: value('XAUTO_SMTP_SECURE') ? value('XAUTO_SMTP_SECURE') !== 'false' : port === 465,
      user,
      pass
    },
    from: value('XAUTO_SMTP_FROM') || user,
    adminEmail,
    currency: value('XAUTO_PLAN_CURRENCY'),
    prices: { monthly: value('XAUTO_PRICE_MONTHLY'), six_months: value('XAUTO_PRICE_SIX_MONTHS'), lifetime: value('XAUTO_PRICE_LIFETIME') },
    monthlyDays: Number.isInteger(days) && days > 0 ? days : 30
  }
}

export interface OtpEmail {
  activationId: string
  planName: string
  priceLabel: string
  otp: string
  expiresAt: Date
}

export type SendOtpEmail = (to: string, from: string, message: { subject: string; text: string }) => Promise<void>

export function otpEmail({ activationId, planName, priceLabel, otp, expiresAt }: OtpEmail): { subject: string; text: string } {
  const expiry = `${expiresAt.toISOString().replace('T', ' ').slice(0, 19)} UTC`
  return {
    subject: `X Auto activation request: ${activationId} (${planName})`,
    text: [
      'An X Auto activation was requested.',
      '',
      `Activation ID: ${activationId}`,
      `Plan: ${planName}`,
      `Price: ${priceLabel}`,
      `OTP: ${otp}`,
      `Expires: ${expiry} (10 minutes after the request)`,
      '',
      'Share this OTP with the user yourself (WhatsApp or a call). It works once, only for this Activation ID and plan.'
    ].join('\n')
  }
}

export function smtpSender(config: LocalOtpConfig): SendOtpEmail {
  const transport = nodemailer.createTransport({ ...config.smtp, auth: { user: config.smtp.user, pass: config.smtp.pass }, tls: { minVersion: 'TLSv1.2' }, connectionTimeout: 15_000, socketTimeout: 20_000 })
  return async (to, from, message) => {
    const { rejected } = await transport.sendMail({ from: `"X Auto Activation" <${from}>`, to, ...message })
    if (rejected.length) throw new Error('rejected')
  }
}

interface PendingOtp {
  plan: PlanId
  salt: string
  /** HMAC of the OTP with its Activation ID and plan: the OTP itself is never stored. */
  hash: string
  createdAt: number
  expiresAt: number
  attempts: number
  usedAt: number | null
}

interface OtpFile {
  version: 1
  pending: PendingOtp | null
  requests: number[]
}

/**
 * Email OTP activation on this PC, with no server. The OTP goes by SMTP to the administrator only;
 * this process keeps only a salted HMAC of it. Codes expire after 10 minutes, work once, are tied to
 * this Activation ID and plan, and are burned after 5 wrong attempts; requests are rate limited.
 *
 * What it can't do without a server: the check runs on the same PC as the user, so someone with full
 * control of this PC and its environment variables could get around it.
 */
export class LocalOtpActivation {
  private state: OtpFile
  private readonly now: () => number
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly deps: {
      filePath: string
      identity: DeviceIdentity
      config: LocalOtpConfig
      send: SendOtpEmail
      log: ScopedLogger
      now?: () => number
    }
  ) {
    this.now = deps.now ?? Date.now
    this.state = this.read()
  }

  get monthlyDays(): number {
    return this.deps.config.monthlyDays
  }

  plans(): SubscriptionPlan[] {
    const { currency, prices, monthlyDays } = this.deps.config
    const lengths: Record<PlanId, string> = { monthly: `${monthlyDays} days`, six_months: '6 months', lifetime: 'Never expires' }
    return (Object.keys(PLAN_NAMES) as PlanId[]).map((id) => ({ id, name: PLAN_NAMES[id], price: prices[id] ?? '', currency: prices[id] ? currency : '', durationLabel: lengths[id] }))
  }

  requestOtp(plan: PlanId): Promise<OtpRequestResult> {
    return this.serial(async () => {
      const now = this.now()
      const recent = this.state.requests.filter((at) => now - at < 3_600_000)
      if (this.state.pending && now - this.state.pending.createdAt < OTP_COOLDOWN_MS) throw new ValidationError('A code was requested moments ago. Please wait a minute.')
      if (recent.length >= REQUESTS_PER_HOUR) throw new ValidationError('Too many requests. Please try again later.')

      const otp = String(randomInt(0, 1_000_000)).padStart(6, '0')
      const salt = randomBytes(16).toString('hex')
      const pending: PendingOtp = { plan, salt, hash: this.hash(salt, plan, otp), createdAt: now, expiresAt: now + OTP_TTL_MS, attempts: 0, usedAt: null }
      const { currency, prices } = this.deps.config
      try {
        await this.deps.send(this.deps.config.adminEmail, this.deps.config.from, otpEmail({
          activationId: this.deps.identity.activationId,
          planName: PLAN_NAMES[plan],
          priceLabel: prices[plan] ? `${currency} ${prices[plan]}`.trim() : 'not set',
          otp,
          expiresAt: new Date(pending.expiresAt)
        }))
      } catch {
        this.deps.log.warn('The activation email could not be sent')
        throw new ValidationError('The activation email could not be sent. Check the internet connection and the email settings, then try again.')
      }
      // A new code replaces the previous one.
      await this.save({ version: 1, pending, requests: [...recent, now] })
      this.deps.log.info(`Activation OTP emailed to the administrator for the ${plan} plan`)
      return { expiresAt: new Date(pending.expiresAt).toISOString() }
    })
  }

  /** Resolves on success; otherwise throws a message for the user. Each code works once. */
  verifyOtp(plan: PlanId, otp: string): Promise<void> {
    return this.serial(async () => {
      const pending = this.state.pending
      if (!/^\d{6}$/.test(otp)) throw new ValidationError('The code has 6 digits.')
      if (!pending) throw new ValidationError('That code is not correct.')
      if (pending.usedAt !== null) throw new ValidationError('That code has already been used.')
      if (this.now() >= pending.expiresAt) throw new ValidationError('That code has expired. Request a new one.')
      if (pending.attempts >= OTP_MAX_ATTEMPTS) throw new ValidationError('Too many wrong attempts. Request a new code.')
      const matches = timingSafeEqual(Buffer.from(pending.hash, 'hex'), Buffer.from(this.hash(pending.salt, plan, otp), 'hex'))
      if (!matches) {
        // Counted before the answer, so a restart can't reset it.
        await this.save({ ...this.state, pending: { ...pending, attempts: pending.attempts + 1 } })
        this.deps.log.warn('Wrong activation OTP entered')
        throw new ValidationError(pending.attempts + 1 >= OTP_MAX_ATTEMPTS ? 'Too many wrong attempts. Request a new code.' : 'That code is not correct.')
      }
      await this.save({ ...this.state, pending: { ...pending, usedAt: this.now() } })
      this.deps.log.success(`Activation OTP accepted for the ${plan} plan`)
    })
  }

  private hash(salt: string, plan: PlanId, otp: string): string {
    return createHmac('sha256', salt).update(`${this.deps.identity.activationId}|${plan}|${otp}`).digest('hex')
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work)
    this.queue = run.catch(() => undefined)
    return run
  }

  private read(): OtpFile {
    try {
      const parsed = JSON.parse(readFileSync(this.deps.filePath, 'utf8')) as Partial<OtpFile>
      if (parsed.version === 1) return { version: 1, pending: parsed.pending ?? null, requests: Array.isArray(parsed.requests) ? parsed.requests : [] }
    } catch {
      // No requests yet.
    }
    return { version: 1, pending: null, requests: [] }
  }

  private async save(next: OtpFile): Promise<void> {
    this.state = next
    await mkdir(dirname(this.deps.filePath), { recursive: true })
    const temp = `${this.deps.filePath}.tmp`
    await writeFile(temp, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 })
    await rename(temp, this.deps.filePath)
  }
}
