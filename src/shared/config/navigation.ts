/** Route identifiers shared by main (start page preference) and renderer. */
export const ROUTE_IDS = [
  'dashboard',
  'accounts',
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
