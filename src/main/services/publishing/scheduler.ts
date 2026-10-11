import type { PublishingSettings } from '@shared/types/publishing'
import type { SqliteDatabase } from '../database/driver'
import type { AccountRepository } from '../database/sqlite/accountRepository'
import type { ScheduleRepository } from '../database/sqlite/scheduleRepository'
import type { ScopedLogger } from '../logging/logger'
import type { Notifier } from '../notifications/notifier'
import type { PublishingService } from './publishingService'

interface Deps {
  db: SqliteDatabase
  schedules: ScheduleRepository
  accounts: AccountRepository
  publishing: PublishingService
  settings: () => PublishingSettings
  notifier: Notifier
  log: ScopedLogger
  onChange: () => void
  now?: () => Date
  tickMs?: number
}

const TICK_MS = 15_000

/**
 * Hands due schedules to the queue, sends reminders, and deals with time that
 * passed while the app was closed or the computer slept: a slot missed by
 * more than the grace period is never published late on its own — it waits
 * for the user (publish now, pick a new time, or cancel).
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly deps: Deps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  /**
   * Run once at start-up, before the queue starts: marks overdue slots as
   * missed (beyond the grace period) and withdraws queued posts that never
   * started and are now too late.
   */
  prepare(): void {
    const now = this.now()
    const graceMs = this.deps.settings().missedGraceMinutes * 60_000
    const stale = this.deps.db.all<{ task_id: string; schedule_id: string; run_at: string; run_after: string }>(
      `SELECT t.id AS task_id, s.id AS schedule_id, s.run_at, t.run_after FROM tasks t JOIN scheduled_posts s ON s.id = t.schedule_id
       WHERE t.kind = 'publish' AND t.status = 'queued' AND s.status = 'queued'`
    )
    let missed = 0
    this.deps.db.transaction(() => {
      for (const row of stale) {
        const late = now.getTime() - new Date(row.run_at).getTime() > graceMs && now.getTime() - new Date(row.run_after).getTime() > graceMs
        if (!late) continue
        this.deps.db.run("UPDATE tasks SET status = 'cancelled', error = 'The scheduled time passed while Axora Relay was closed.', error_code = 'MISSED', finished_at = :now, updated_at = :now WHERE id = :id AND status = 'queued'", {
          id: row.task_id,
          now: now.toISOString()
        })
        this.deps.schedules.setStatus(row.schedule_id, 'missed', now.toISOString())
        missed++
      }
    })
    missed += this.process()
    if (missed) this.reportMissed(missed)
  }

  start(): void {
    this.stop()
    this.timer = setInterval(() => this.tick(), this.deps.tickMs ?? TICK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Checks now (also called after the computer wakes up). */
  tick(): void {
    try {
      const missed = this.process()
      if (missed) this.reportMissed(missed)
      this.remind()
    } catch (error) {
      this.deps.log.error('The scheduler hit an error', error)
    }
  }

  /** Queues due slots within the grace period; marks older ones as missed. Returns how many were missed. */
  private process(): number {
    const now = this.now()
    const graceMs = this.deps.settings().missedGraceMinutes * 60_000
    let missed = 0
    for (const schedule of this.deps.schedules.due(now.toISOString())) {
      if (now.getTime() - new Date(schedule.runAt).getTime() > graceMs) {
        this.deps.schedules.setStatus(schedule.id, 'missed', now.toISOString(), ['pending'])
        missed++
        continue
      }
      this.deps.publishing.enqueue(schedule)
      this.deps.log.info(`Schedule ${schedule.id.slice(0, 8)} is due; queued for publishing`)
    }
    if (missed) {
      this.deps.log.warn(`${missed} scheduled post(s) passed their time while Axora Relay was not running`)
      this.deps.onChange()
    }
    return missed
  }

  private remind(): void {
    const minutes = this.deps.settings().reminderMinutes
    if (minutes <= 0) return
    const now = this.now()
    const until = new Date(now.getTime() + minutes * 60_000).toISOString()
    for (const schedule of this.deps.schedules.needingReminder(now.toISOString(), until)) {
      const account = this.deps.accounts.get(schedule.accountId)
      const at = new Date(schedule.runAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      this.deps.notifier.notify({
        tone: 'info',
        event: 'scheduleReminders',
        title: `Post going out at ${at}`,
        body: `A scheduled post for ${account?.label ?? 'an account'} will be published soon.`,
        to: '/scheduler'
      })
      this.deps.schedules.markReminded(schedule.id, now.toISOString())
    }
  }

  private reportMissed(count: number): void {
    this.deps.notifier.notify(
      {
        tone: 'warning',
        event: 'taskFailures',
        title: count === 1 ? 'A scheduled post was missed' : `${count} scheduled posts were missed`,
        body: `${count === 1 ? 'Its' : 'Their'} time passed while Axora Relay was not running. Choose to publish now, reschedule or cancel.`,
        to: '/scheduler?view=attention'
      },
      { key: 'schedules-missed', quietMs: 10 * 60_000 }
    )
  }
}
