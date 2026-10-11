import type { Timestamp } from './domain'

/**
 * in-app: the update is downloaded, verified (SHA-512 from the release metadata) and installed on
 *   restart — installed Windows app (NSIS), Linux AppImage, macOS app signed with a Developer ID.
 * manual: new versions are detected, and the release page is opened for the user to download —
 *   Linux .deb, the Windows ZIP, unsigned macOS builds (macOS refuses to replace them in place).
 * disabled: development builds (unless a local test feed is configured explicitly).
 */
export type UpdateMode = 'in-app' | 'manual' | 'disabled'

export type UpdateState = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error'

export interface AvailableUpdate {
  version: string
  releaseDate: Timestamp | null
  /** Plain text (HTML tags removed) — from the GitHub Release notes. */
  releaseNotes: string | null
  /** The GitHub Release page of that version (only github.com links are ever opened). */
  releaseUrl: string | null
}

export interface UpdateStatus {
  mode: UpdateMode
  /** Why updates are manual or off, in plain words (null for in-app). */
  modeReason: string | null
  currentVersion: string
  /** Stable builds only ever see stable releases; a pre-release build also sees pre-releases. */
  channel: 'stable' | 'prerelease'
  state: UpdateState
  available: AvailableUpdate | null
  progress: { percent: number; transferred: number; total: number; bytesPerSecond: number } | null
  lastCheckedAt: Timestamp | null
  /** Plain-language problem (never a stack trace or raw error). */
  error: string | null
  /** Set while installing would interrupt running automation. */
  installBlockedReason: string | null
}
