import type { Id, Timestamp } from './domain'

export type EngineState = 'stopped' | 'starting' | 'ready' | 'stopping' | 'crashed' | 'failed' | 'unavailable'

export interface EngineLogLine {
  at: Timestamp
  source: 'engine' | 'stderr' | 'error'
  text: string
}

/** The Python automation engine, as supervised by the main process. */
export interface EngineStatus {
  state: EngineState
  pid: number | null
  startedAt: Timestamp | null
  versions: { engine: string; python: string; playwright: string | null; platform: string } | null
  /** Restarts after crashes in the last 5 minutes (max 3). */
  restartsRecent: number
  lastError: string | null
  runtime: { python: string; pythonFound: boolean; engineFound: boolean }
  logs: EngineLogLine[]
}

export interface EngineSelfCheck {
  ok: boolean
  checkedAt: Timestamp
  python: string | null
  playwright: string | null
  /** Time to start Playwright's driver inside the engine. */
  driverStartMs: number | null
  error: string | null
}

export type CompatStepName = 'ix-connection' | 'profile-open' | 'debugging-address' | 'engine' | 'connect' | 'open-tab' | 'navigate' | 'interact' | 'screenshot' | 'close-tab' | 'profile-close'

export interface CompatStep {
  step: CompatStepName
  ok: boolean
  detail: string
  ms: number | null
}

/**
 * Result of the automation compatibility check for one IX Browser profile:
 * open through the Local API → debugging address → Playwright connect_over_cdp
 * → controlled page in the profile's own context. Every step is a real action.
 */
export interface CompatibilityResult {
  profileId: Id
  externalId: number
  ok: boolean
  checkedAt: Timestamp
  steps: CompatStep[]
  browserVersion: string | null
  /** The profile's existing browser context was used (no new context or browser launched). */
  usedExistingContext: boolean
  /** Screenshot of the controlled test page, in the diagnostics folder. */
  screenshot: string | null
  /** What is missing when the check fails because of IX Browser. */
  blocker: string | null
}
