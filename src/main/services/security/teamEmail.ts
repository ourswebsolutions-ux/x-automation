import type { CredentialVault } from '../credentials/credentialVault'
import type { ScopedLogger } from '../logging/logger'

/**
 * Email OTP settings for the team installer (scripts/build-team-installer.mjs). Public builds, made
 * on GitHub, have none: this is null there. The team installer is shared privately, never published.
 */
declare const __XAUTO_TEAM_EMAIL__: Record<string, string> | null | undefined

export const EMAIL_SETTING_NAMES = [
  'XAUTO_SMTP_HOST',
  'XAUTO_SMTP_PORT',
  'XAUTO_SMTP_SECURE',
  'XAUTO_SMTP_USER',
  'XAUTO_SMTP_PASS',
  'XAUTO_SMTP_FROM',
  'XAUTO_ADMIN_EMAIL',
  'XAUTO_PLAN_CURRENCY',
  'XAUTO_PRICE_MONTHLY',
  'XAUTO_PRICE_SIX_MONTHS',
  'XAUTO_PRICE_LIFETIME',
  'XAUTO_PLAN_MONTHLY_DAYS'
] as const

const VAULT_KEY = 'activation.email-settings'

const pick = (source: Record<string, unknown> | null | undefined): Record<string, string> | null => {
  if (!source || typeof source !== 'object') return null
  const out: Record<string, string> = {}
  for (const name of EMAIL_SETTING_NAMES) {
    const value = source[name]
    if (typeof value === 'string' && value.trim()) out[name] = value
  }
  return out.XAUTO_SMTP_USER && out.XAUTO_SMTP_PASS && out.XAUTO_ADMIN_EMAIL ? out : null
}

export function builtInEmailSettings(): Record<string, string> | null {
  return typeof __XAUTO_TEAM_EMAIL__ === 'object' ? pick(__XAUTO_TEAM_EMAIL__) : null
}

/**
 * Where email OTP settings come from, first match wins:
 *  1. this PC's environment variables,
 *  2. settings kept on this PC, encrypted with its user account (Windows DPAPI),
 *  3. the team installer's built-in settings, which are also kept (2) so that a later update from
 *     GitHub, which has none, carries on working.
 */
export async function resolveEmailSettings(deps: { env: NodeJS.ProcessEnv; builtIn: Record<string, string> | null; vault: CredentialVault; log: ScopedLogger }): Promise<NodeJS.ProcessEnv> {
  const { env, builtIn, vault, log } = deps
  if (builtIn && vault.status().secure) {
    const current = vault.get(VAULT_KEY)
    const next = JSON.stringify(builtIn)
    if (current !== next) {
      await vault.set(VAULT_KEY, next).catch(() => log.warn('Email settings could not be kept on this PC'))
      log.info('Email settings from the team installer are kept on this PC')
    }
  }
  if (pick(env as Record<string, unknown>)) return env
  let saved: Record<string, string> | null = null
  try {
    saved = pick(JSON.parse(vault.get(VAULT_KEY) ?? 'null') as Record<string, unknown>)
  } catch {
    saved = null
  }
  if (saved) return { ...env, ...saved }
  if (builtIn) return { ...env, ...builtIn }
  return env
}
