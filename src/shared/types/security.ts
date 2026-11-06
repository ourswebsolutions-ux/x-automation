/** The app lock. The PIN and its hash never cross into the renderer. */
export interface PinStatus {
  configured: boolean
  unlocked: boolean
  /** While wrong attempts have locked entry out: when it may be tried again. */
  retryAt: string | null
  attemptsLeft: number
}

export interface PinVerifyResult {
  ok: boolean
  status: PinStatus
}

export interface PinSetupResult {
  /** Shown once. It is the only way back in if the PIN is forgotten. */
  recoveryCode: string
  status: PinStatus
}

export const PLAN_IDS = ['monthly', 'six_months', 'lifetime'] as const
export type PlanId = (typeof PLAN_IDS)[number]

export const PLAN_NAMES: Record<PlanId, string> = { monthly: 'Monthly', six_months: '6 Months', lifetime: 'Lifetime' }

/** Prices and durations come from the activation server; the app holds none. */
export interface SubscriptionPlan {
  id: PlanId
  name: string
  price: string
  currency: string
  durationLabel: string
}

/**
 * none: never activated. stale: this device hasn't reached the server for too long to tell.
 * The rest are what the server reports.
 */
export type SubscriptionState = 'none' | 'active' | 'expired' | 'revoked' | 'stale'

export interface SubscriptionStatus {
  activationId: string
  state: SubscriptionState
  plan: PlanId | null
  /** null for Lifetime. */
  expiresAt: string | null
  lastCheckedAt: string | null
  /** False when this build has no activation server address. */
  serviceConfigured: boolean
}

export interface OtpRequestResult {
  expiresAt: string
}

export interface AccessSnapshot {
  pin: PinStatus
  subscription: SubscriptionStatus
}
