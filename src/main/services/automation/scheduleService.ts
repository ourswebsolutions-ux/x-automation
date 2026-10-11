import { randomUUID } from 'node:crypto'
import type { AutomationConfig, AutomationSchedule, AutomationScheduleInput } from '@shared/types/automation'
import type { Id } from '@shared/types/domain'
import type { SqliteDatabase } from '../database/driver'
import { ConflictError, NotFoundError, ValidationError } from '../errors'
import type { ScopedLogger } from '../logging/logger'
import type { Notifier } from '../notifications/notifier'
import { parseConfig } from './configSchema'
import type { RunService } from './runService'

interface Deps {
  db: SqliteDatabase
  runs: Pick<RunService, 'start' | 'active' | 'pause' | 'resume' | 'details'>
  notifier: Notifier
  log: ScopedLogger
  onChange: () => void
  now?: () => Date
}

interface Row {
  id: string
  name: string
  status: AutomationSchedule['status']
  config: string
  preset_id: string | null
  start_date: string
  end_date: string | null
  days: number
  window_start: string
  window_end: string
  last_run_date: string | null
  last_run_id: string | null
  last_message: string | null
  created_at: string
  updated_at: string
}

const TICK_MS = 15_000
const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const pad = (n: number) => String(n).padStart(2, '0')
/** Local calendar date (YYYY-MM-DD) — schedules follow this computer's clock. */
export const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))
const atLocal = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00`)
const maskOf = (days: number[]) => days.reduce((m, d) => m | (1 << d), 0)
const daysOf = (mask: number) => [0, 1, 2, 3, 4, 5, 6].filter((d) => mask & (1 << d))

/**
 * Recurring automation schedules — separate from the schedules of individual
 * posts. On each chosen day, between the start and end dates, a schedule
 * starts one automation run whose posts are spread inside the daily window.
 * Runs happen only while Axora Relay is running: a day missed while the app
 * was closed is not made up later, but a window that is still open when the
 * app starts is used for its remaining time.
 */
export class AutomationScheduleService {
  private timer: NodeJS.Timeout | null = null
  private ticking: Promise<void> | null = null
  private tickAgain = false

  constructor(private readonly deps: Deps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref?.()
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // ── records ──────────────────────────────────────────────────────────────

  list(): AutomationSchedule[] {
    return this.deps.db.all<Row>('SELECT * FROM automation_schedules ORDER BY name COLLATE NOCASE').map((r) => this.toSchedule(r))
  }

  get(id: Id): AutomationSchedule {
    return this.toSchedule(this.requireRow(id))
  }

  save(input: AutomationScheduleInput): AutomationSchedule {
    const name = input.name.trim()
    if (!name || name.length > 80) throw new ValidationError('Give the schedule a name (up to 80 characters).')
    const config = parseConfig(input.config)
    if (!DATE.test(input.startDate) || Number.isNaN(atLocal(input.startDate, '00:00').getTime())) throw new ValidationError('Choose a start date.')
    if (input.endDate !== null && (!DATE.test(input.endDate) || Number.isNaN(atLocal(input.endDate, '00:00').getTime()))) throw new ValidationError('Choose a valid end date, or leave it empty.')
    if (input.endDate !== null && input.endDate < input.startDate) throw new ValidationError('The end date must be on or after the start date.')
    const days = [...new Set(input.days)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    if (!days.length) throw new ValidationError('Choose at least one day of the week.')
    if (!TIME.test(input.windowStart) || !TIME.test(input.windowEnd)) throw new ValidationError('Use HH:MM for the daily hours.')
    if (minutesOf(input.windowEnd) - minutesOf(input.windowStart) < 15) throw new ValidationError('The daily hours must end at least 15 minutes after they start (overnight hours are not supported).')
    if (config.content.source !== 'generate') {
      throw new ValidationError('A recurring schedule generates new posts each day, so it can’t use a fixed set of your drafts. Choose generated posts, or start a single run with your drafts.')
    }
    if (!config.content.generateText && config.content.fixedText.trim()) {
      throw new ValidationError('A recurring schedule would post the same fixed text every day. Turn text generation on.')
    }
    const clash = this.deps.db.get<{ id: string }>('SELECT id FROM automation_schedules WHERE lower(name) = lower(:name)', { name })
    if (clash && clash.id !== input.id) throw new ValidationError('A schedule with that name already exists.')
    if (input.id) this.requireRow(input.id)

    const now = this.now().toISOString()
    const id = input.id ?? randomUUID()
    const ended = input.endDate !== null && input.endDate < localDate(this.now())
    this.deps.db.run(
      `INSERT INTO automation_schedules (id, name, status, config, preset_id, start_date, end_date, days, window_start, window_end, created_at, updated_at)
       VALUES (:id, :name, :status, :config, :presetId, :startDate, :endDate, :days, :windowStart, :windowEnd, :now, :now)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, config = excluded.config, preset_id = excluded.preset_id, start_date = excluded.start_date,
         end_date = excluded.end_date, days = excluded.days, window_start = excluded.window_start, window_end = excluded.window_end,
         status = CASE WHEN :ended THEN 'ended' WHEN automation_schedules.status = 'ended' THEN 'active' ELSE automation_schedules.status END,
         updated_at = excluded.updated_at`,
      {
        id,
        name,
        status: ended ? 'ended' : 'active',
        config: JSON.stringify(config),
        presetId: input.presetId,
        startDate: input.startDate,
        endDate: input.endDate,
        days: maskOf(days),
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        ended: ended ? 1 : 0,
        now
      }
    )
    this.deps.log.info(input.id ? 'Automation schedule updated' : 'Automation schedule created', { days: days.length })
    this.deps.onChange()
    void this.tick()
    return this.get(id)
  }

  remove(id: Id): void {
    if (!this.deps.db.run('DELETE FROM automation_schedules WHERE id = :id', { id }).changes) throw new NotFoundError('That schedule no longer exists.')
    this.deps.onChange()
  }

  /** No new day starts; today's run (if any) is paused too. */
  pause(id: Id): AutomationSchedule {
    const row = this.requireRow(id)
    if (row.status === 'ended') throw new ConflictError('This schedule has ended. Change its end date to use it again.')
    this.setFields(id, { status: 'paused' })
    const run = this.deps.runs.active()
    if (run && run.scheduleId === id && run.status !== 'paused') {
      try {
        this.deps.runs.pause(run.id)
      } catch {
        // The run finished in the meantime.
      }
    }
    this.deps.notifier.notify({ tone: 'info', event: 'systemNotices', title: 'Automation schedule paused', body: `“${row.name}” won’t start new runs until you resume it.`, to: '/automation/schedules' })
    this.deps.onChange()
    return this.get(id)
  }

  resume(id: Id): AutomationSchedule {
    const row = this.requireRow(id)
    if (row.status === 'ended') throw new ConflictError('This schedule has ended. Change its end date to use it again.')
    this.setFields(id, { status: 'active' })
    const run = this.deps.runs.active()
    if (run && run.scheduleId === id && run.status === 'paused') {
      try {
        this.deps.runs.resume(run.id)
      } catch {
        // Not resumable any more.
      }
    }
    this.deps.notifier.notify({ tone: 'info', event: 'systemNotices', title: 'Automation schedule resumed', body: `“${row.name}” runs on its next day and time.`, to: '/automation/schedules' })
    this.deps.onChange()
    void this.tick()
    return this.get(id)
  }

  // ── timing ───────────────────────────────────────────────────────────────

  /** The start of the next window this schedule will run in, from `from` on (today's window if still open). */
  nextRunAt(row: Pick<Row, 'status' | 'start_date' | 'end_date' | 'days' | 'window_start' | 'window_end' | 'last_run_date'>, from = this.now()): Date | null {
    if (row.status !== 'active') return null
    const mask = row.days
    const cursor = new Date(from)
    for (let i = 0; i < 400; i++) {
      const date = localDate(cursor)
      if (row.end_date && date > row.end_date) return null
      const windowEnd = atLocal(date, row.window_end)
      if (date >= row.start_date && mask & (1 << cursor.getDay()) && row.last_run_date !== date && windowEnd > from) {
        const windowStart = atLocal(date, row.window_start)
        return windowStart > from ? windowStart : from
      }
      cursor.setDate(cursor.getDate() + 1)
      cursor.setHours(0, 0, 0, 0)
    }
    return null
  }

  /** Starts today's run for every due schedule. Safe to call at any time (one run per schedule per day). */
  async tick(): Promise<void> {
    // A call during a pass is not dropped: one more pass runs right after (state may have changed).
    if (this.ticking) {
      this.tickAgain = true
      return this.ticking
    }
    this.ticking = (async () => {
      do {
        this.tickAgain = false
        await this.pass()
      } while (this.tickAgain)
    })()
    try {
      await this.ticking
    } finally {
      this.ticking = null
    }
  }

  private async pass(): Promise<void> {
    try {
      const now = this.now()
      const today = localDate(now)
      const minute = now.getHours() * 60 + now.getMinutes()
      for (const row of this.deps.db.all<Row>("SELECT * FROM automation_schedules WHERE status = 'active' ORDER BY created_at")) {
        if (row.end_date && today > row.end_date) {
          this.setFields(row.id, { status: 'ended', last_message: 'Ended: the end date has passed.' })
          this.deps.onChange()
          continue
        }
        if (today < row.start_date || !(row.days & (1 << now.getDay())) || row.last_run_date === today) continue
        const from = minutesOf(row.window_start)
        const to = minutesOf(row.window_end)
        if (minute < from) continue
        if (minute >= to) {
          // The window passed without a run (app closed, or another run kept it busy): note it once.
          this.setFields(row.id, { last_run_date: today, last_message: `Didn’t run on ${today}: Axora Relay wasn’t running or another automation was active during the daily hours.` })
          this.deps.onChange()
          continue
        }
        await this.startToday(row, today)
      }
    } catch (error) {
      this.deps.log.error('Automation schedule check failed', error)
    }
  }

  private async startToday(row: Row, today: string): Promise<void> {
    const active = this.deps.runs.active()
    if (active) return // one run at a time; tried again on the next tick while the window is open
    let base: AutomationConfig
    try {
      base = parseConfig(JSON.parse(row.config))
    } catch {
      this.setFields(row.id, { status: 'paused', last_run_date: today, last_message: 'Paused: the saved settings are no longer valid. Edit and save the schedule again.' })
      this.deps.onChange()
      return
    }
    const config: AutomationConfig = {
      ...base,
      name: `${row.name} · ${today}`.slice(0, 80),
      schedule: {
        ...base.schedule,
        when: 'now',
        startAt: null,
        endAt: atLocal(today, row.window_end).toISOString(),
        workingHours: { enabled: true, start: row.window_start, end: row.window_end }
      }
    }
    try {
      const run = await this.deps.runs.start(config, row.preset_id, { scheduleId: row.id })
      this.setFields(row.id, { last_run_date: today, last_run_id: run.id, last_message: null })
      this.deps.log.info('Automation schedule started its daily run')
    } catch (error) {
      if (error instanceof ConflictError) return // another run started meanwhile; retry next tick
      const reason = error instanceof Error ? error.message : 'It could not start.'
      this.setFields(row.id, { last_run_date: today, last_message: `Didn’t run on ${today}: ${reason}` })
      this.deps.notifier.notify(
        { tone: 'warning', event: 'taskFailures', title: 'Scheduled automation didn’t start', body: `“${row.name}”: ${reason}`, to: '/automation/schedules' },
        { key: `schedule-failed:${row.id}:${today}` }
      )
    }
    this.deps.onChange()
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private requireRow(id: Id): Row {
    const row = this.deps.db.get<Row>('SELECT * FROM automation_schedules WHERE id = :id', { id })
    if (!row) throw new NotFoundError('That schedule no longer exists.')
    return row
  }

  private setFields(id: Id, patch: Partial<Pick<Row, 'status' | 'last_run_date' | 'last_run_id' | 'last_message'>>): void {
    const sets = Object.keys(patch).map((k) => `${k} = :${k}`)
    this.deps.db.run(`UPDATE automation_schedules SET ${[...sets, 'updated_at = :now'].join(', ')} WHERE id = :id`, { id, now: this.now().toISOString(), ...patch })
  }

  private toSchedule(r: Row): AutomationSchedule {
    let config: AutomationConfig
    try {
      config = parseConfig(JSON.parse(r.config))
    } catch {
      config = JSON.parse(r.config) as AutomationConfig
    }
    const next = this.nextRunAt(r)
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      config,
      presetId: r.preset_id,
      startDate: r.start_date,
      endDate: r.end_date,
      days: daysOf(r.days),
      windowStart: r.window_start,
      windowEnd: r.window_end,
      lastRunDate: r.last_run_date,
      lastRunId: r.last_run_id,
      lastMessage: r.last_message,
      nextRunAt: next ? next.toISOString() : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }
  }
}
