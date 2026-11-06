import { createPrivateKey } from 'node:crypto'

const PRICE = /^\d+(\.\d{1,2})?$/

function required(env, name) {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is not set`)
  return value
}

function positiveInt(env, name, fallback) {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive whole number`)
  return value
}

/** Plans come only from configuration: a plan without a price is simply not offered. */
export function loadPlans(env) {
  const currency = env.PLAN_CURRENCY?.trim() ?? ''
  const monthlyDays = positiveInt(env, 'PLAN_MONTHLY_DAYS', 30)
  const candidates = [
    { id: 'monthly', name: 'Monthly', priceVar: 'PLAN_MONTHLY_PRICE', duration: { days: monthlyDays }, durationLabel: `${monthlyDays} days` },
    { id: 'six_months', name: '6 Months', priceVar: 'PLAN_SIX_MONTHS_PRICE', duration: { months: 6 }, durationLabel: '6 months' },
    { id: 'lifetime', name: 'Lifetime', priceVar: 'PLAN_LIFETIME_PRICE', duration: null, durationLabel: 'Never expires' }
  ]
  const plans = []
  for (const { priceVar, ...plan } of candidates) {
    const price = env[priceVar]?.trim()
    if (!price) continue
    if (!PRICE.test(price)) throw new Error(`${priceVar} must be a number such as 2500 or 19.99`)
    if (!currency) throw new Error('PLAN_CURRENCY must be set when a plan has a price')
    plans.push({ ...plan, price, currency })
  }
  return plans
}

/** Exactly one address: commas or display names could add a recipient. */
export const isEmailAddress = (value) => typeof value === 'string' && /^[^\s@,;<>"]+@[^\s@,;<>".]+(\.[^\s@,;<>".]+)+$/.test(value)

export function loadConfig(env = process.env) {
  const adminEmail = required(env, 'ADMIN_EMAIL')
  if (!isEmailAddress(adminEmail)) throw new Error('ADMIN_EMAIL must be one email address')
  const pepper = required(env, 'OTP_PEPPER')
  if (pepper.length < 32) throw new Error('OTP_PEPPER must be at least 32 characters')
  const privateKey = createPrivateKey({ key: Buffer.from(required(env, 'SIGNING_PRIVATE_KEY'), 'base64'), format: 'der', type: 'pkcs8' })
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('SIGNING_PRIVATE_KEY must be an Ed25519 key')
  return {
    port: positiveInt(env, 'PORT', 8787),
    host: env.HOST?.trim() || '127.0.0.1',
    trustProxy: env.TRUST_PROXY === '1',
    databasePath: env.DATABASE_PATH?.trim() || './data/activation.db',
    leaseMs: positiveInt(env, 'LEASE_DAYS', 7) * 86_400_000,
    otpPepper: pepper,
    privateKey,
    adminEmail,
    /** Allows the test-only `reset` command. Never set in production. */
    staging: env.STAGING === '1',
    smtp: {
      host: required(env, 'SMTP_HOST'),
      port: positiveInt(env, 'SMTP_PORT', 465),
      secure: env.SMTP_SECURE !== 'false',
      user: required(env, 'SMTP_USER'),
      // Gmail displays app passwords in groups of four.
      pass: required(env, 'SMTP_PASS').replace(/\s+/g, ''),
      from: env.SMTP_FROM?.trim() || required(env, 'SMTP_USER')
    },
    plans: loadPlans(env)
  }
}
