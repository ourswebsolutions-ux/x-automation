/** Route identifiers shared by main (start page preference) and renderer. */
export const ROUTE_IDS = [
  'dashboard',
  'accounts',
  'create',
  'campaigns',
  // Pages merged into Create Post / Campaign Automation; kept so old links and settings still resolve.
  'generator',
  'posts',
  'automation',
  'schedules',
  'scheduler',
  'queue',
  'links',
  'settings'
] as const

export type RouteId = (typeof ROUTE_IDS)[number]

export function isRouteId(value: unknown): value is RouteId {
  return typeof value === 'string' && (ROUTE_IDS as readonly string[]).includes(value)
}

/** Merged pages → the page that now holds them (for stored preferences such as the start page). */
export const LEGACY_ROUTES: Partial<Record<RouteId, RouteId>> = {
  generator: 'create',
  posts: 'create',
  automation: 'campaigns',
  schedules: 'campaigns',
  scheduler: 'campaigns',
  queue: 'campaigns'
}
