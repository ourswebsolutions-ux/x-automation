import type { NotificationEvent } from './preferences'

/**
 * A user-facing notice raised by the main process (publishing results,
 * reminders, queue problems). Text is plain language — never raw error output,
 * paths, credentials or post content beyond a short preview.
 */
export interface AppNotice {
  tone: 'info' | 'success' | 'warning' | 'danger'
  title: string
  body?: string
  /** Route to open when the notice is clicked, e.g. "/queue". */
  to?: string
  /** Which notification preference governs it. */
  event: NotificationEvent
}
