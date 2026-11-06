/**
 * Verifies entitlements signed by the activation server. Public by nature: the private half stays
 * on the server. Replacing it means every installed copy needs an update, so keep the server's
 * SIGNING_PRIVATE_KEY backed up.
 */
export const ACTIVATION_PUBLIC_KEY = 'MCowBQYDK2VwAyEAMH7Vd/fCpqdVFixaoVkV2VMtlgi71LvX2Hc4MJkbYjQ='

/** How often a running app renews its lease, and notices a revocation. */
export const SUBSCRIPTION_REFRESH_MS = 6 * 60 * 60 * 1000
