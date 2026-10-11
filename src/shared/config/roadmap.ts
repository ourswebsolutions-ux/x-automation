/**
 * Single source of truth for delivery phases. UI copy and integration states
 * reference these instead of hard-coding numbers.
 */
export const PHASE = {
  foundation: 1,
  data: 2,
  ixBrowser: 3,
  accounts: 4,
  aiProviders: 5,
  generator: 6,
  images: 7,
  publishing: 8,
  engagement: 9,
  automation: 10,
  usage: 11,
  release: 12
} as const

export const CURRENT_PHASE = PHASE.release
