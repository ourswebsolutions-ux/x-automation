import type { AppNotice } from '@shared/types/notifications'
import type { ScopedLogger } from '../logging/logger'
import type { PreferencesStore } from '../preferences/preferencesStore'

interface Deps {
  preferences: PreferencesStore
  log: ScopedLogger
  /** Shows a native desktop notification; returns false when unsupported. */
  desktop?: (notice: AppNotice) => boolean
}

/** Repeats of the same continuing problem are held back for this long. */
const DEFAULT_QUIET_MS = 30 * 60_000

/**
 * The one place user-facing notices are raised from the main process. Each
 * notice goes to the in-app notification centre and, when the user enabled it
 * for that kind of event, to a desktop notification. Notices with a key are
 * de-duplicated so a continuing failure does not repeat itself.
 */
export class Notifier {
  private sink: ((notice: AppNotice) => void) | null = null
  private rendererReady = false
  /** In-app notices raised before the renderer was listening (e.g. at start-up). */
  private readonly backlog: AppNotice[] = []
  private readonly lastShown = new Map<string, number>()

  constructor(private readonly deps: Deps) {}

  /** The renderer bridge (set once the window exists). */
  attach(sink: (notice: AppNotice) => void): void {
    this.sink = sink
  }

  /** The renderer is listening: deliver anything held back. */
  rendererListening(): void {
    this.rendererReady = true
    for (const notice of this.backlog.splice(0)) this.sink?.(notice)
  }

  notify(notice: AppNotice, options: { key?: string; quietMs?: number } = {}): boolean {
    if (options.key) {
      const last = this.lastShown.get(options.key)
      if (last && Date.now() - last < (options.quietMs ?? DEFAULT_QUIET_MS)) return false
      this.lastShown.set(options.key, Date.now())
    }
    const prefs = this.deps.preferences.get().notifications[notice.event]
    if (prefs.inApp) {
      if (this.sink && this.rendererReady) this.sink(notice)
      else if (this.backlog.push(notice) > 20) this.backlog.shift()
    }
    if (prefs.desktop && this.deps.desktop) {
      try {
        this.deps.desktop(notice)
      } catch (error) {
        this.deps.log.error('Desktop notification failed', error)
      }
    }
    return true
  }

  /** Lets a resolved problem be reported again if it comes back. */
  clear(key: string): void {
    this.lastShown.delete(key)
  }
}
