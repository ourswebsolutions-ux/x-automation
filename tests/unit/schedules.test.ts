// Recurring automation schedules: validation, which days/hours start a run, once per day, pause/resume,
// end dates, and how a refused start is reported. The run service is a recording fake; the database is real.
import { rmSync } from 'node:fs'
import { SqliteDatabase } from '../../src/main/services/database/driver'
import { migrate } from '../../src/main/services/database/migrator'
import { AutomationScheduleService, localDate } from '../../src/main/services/automation/scheduleService'
import { ConflictError, ValidationError } from '../../src/main/services/errors'
import type { AutomationConfig, AutomationRun } from '../../src/shared/types/automation'

const results: string[] = []
const check = (name: string, ok: boolean, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + String(extra).slice(0, 300) : ''}`)
const log = { debug() {}, info() {}, success() {}, warn() {}, error() {} }
const errOf = async (fn: () => unknown) => { try { await fn(); return 'none' } catch (e) { return (e as Error).message } }

const file = process.argv[2]!
rmSync(file, { force: true })
const db = new SqliteDatabase(file).open()
check('migrate → v13', migrate(db, log as never) === 13)
check('automation_schedules table and run/item columns exist', db.all<{ name: string }>("SELECT name FROM pragma_table_info('automation_runs')").some((c) => c.name === 'schedule_id') && db.all<{ name: string }>("SELECT name FROM pragma_table_info('run_items')").some((c) => c.name === 'source_draft_id'))

// A Monday, 2026-10-12, at 08:00 local time; the clock is moved by the test.
let now = new Date(2026, 9, 12, 8, 0)
const starts: { config: AutomationConfig; presetId: string | null; scheduleId?: string }[] = []
let active: AutomationRun | null = null
let startError: Error | null = null
const paused: string[] = []
const resumed: string[] = []
const runs = {
  async start(config: AutomationConfig, presetId: string | null, options: { scheduleId?: string } = {}) {
    if (startError) throw startError
    starts.push({ config, presetId, scheduleId: options.scheduleId })
    const run = { id: `run-${starts.length}`, status: 'generating', scheduleId: options.scheduleId ?? null } as AutomationRun
    db.run("INSERT INTO automation_runs (id, name, mode, status, config, schedule_id, created_at, updated_at) VALUES (:id, 'r', 'full-auto', 'generating', '{}', :s, :at, :at)", { id: run.id, s: options.scheduleId ?? null, at: now.toISOString() })
    return run
  },
  active: () => active,
  pause: (id: string) => { paused.push(id); return {} as AutomationRun },
  resume: (id: string) => { resumed.push(id); return {} as AutomationRun },
  details: () => ({}) as never
}
const notices: { title: string; body?: string }[] = []
const notifier = { notify: (n: { title: string; body?: string }) => notices.push(n), clear() {} }
const svc = new AutomationScheduleService({ db, runs: runs as never, notifier: notifier as never, log: log as never, onChange() {}, now: () => now })

const config = (): AutomationConfig => ({
  name: 'Daily tips',
  mode: 'full-auto',
  content: { source: 'generate', draftIds: [], prompt: 'Short developer tips', topic: '', language: 'English', tone: 'professional', length: 'short', hashtags: [], suggestHashtags: false, instructions: '', generateText: true, textProviderId: null, textModel: null, fixedText: '', generateImages: false, imageProviderId: null, imageModel: null, imageStyle: 'illustration', imageSize: '1024x1024', existingAssetId: null },
  targets: { scope: 'all', profileIds: [], distribution: 'unique', allowDuplicates: false, requireConfirmedIdentity: true, createMissingAccounts: false },
  actions: { publish: true, saveDrafts: false, repost: false, comment: false, like: false, engagementLinks: [], commentText: '' },
  schedule: { when: 'now', startAt: null, endAt: null, intervalMinutes: 60, postsPerProfile: 3, maxPostsPerRun: 20, workingHours: { enabled: false, start: '09:00', end: '18:00' } },
  failure: { generationRetries: 1, onTextFailure: 'skip', onImageFailure: 'pause', onProfileUnavailable: 'skip', stopAfterFailures: 3 }
})
const input = (patch: Record<string, unknown> = {}) => ({ name: 'Weekday tips', config: config(), presetId: null, startDate: '2026-10-12', endDate: '2026-10-23', days: [1, 2, 3, 4, 5], windowStart: '09:00', windowEnd: '17:00', ...patch })

// ── validation ──
check('needs at least one day', (await errOf(() => svc.save(input({ days: [] })))).includes('at least one day'))
check('end date before start date refused', (await errOf(() => svc.save(input({ endDate: '2026-10-01' })))).includes('on or after'))
check('daily hours must end after they start (no overnight)', (await errOf(() => svc.save(input({ windowStart: '22:00', windowEnd: '02:00' })))).includes('overnight'))
check('a fixed set of drafts can’t recur', (await errOf(() => svc.save(input({ config: { ...config(), content: { ...config().content, source: 'drafts', draftIds: ['aaaaaaaa-0000-4000-8000-000000000001'] } } })))).includes('drafts'))
check('the same fixed text every day refused', (await errOf(() => svc.save(input({ config: { ...config(), content: { ...config().content, generateText: false, fixedText: 'Hello' } } })))).includes('same fixed text'))
check('invalid automation settings refused', (await errOf(() => svc.save(input({ config: { ...config(), schedule: { ...config().schedule, postsPerProfile: 0 } } })))) !== 'none')

const s1 = svc.save(input())
check('saved: active, days and hours kept', s1.status === 'active' && s1.days.join() === '1,2,3,4,5' && s1.windowStart === '09:00' && s1.windowEnd === '17:00')
check('next run: today at the window start', s1.nextRunAt === new Date(2026, 9, 12, 9, 0).toISOString(), s1.nextRunAt ?? 'null')
check('names are unique', (await errOf(() => svc.save(input({ name: 'weekday TIPS' })))).includes('already exists'))

// ── ticks ──
await svc.tick()
check('before the daily hours: nothing starts', starts.length === 0)
now = new Date(2026, 9, 12, 9, 5)
await svc.tick()
check('inside the hours on a chosen day: one run starts', starts.length === 1 && starts[0]!.scheduleId === s1.id)
const c0 = starts[0]!.config
check('… posts spread inside today’s hours only (window as working hours, ends at window end)', c0.schedule.when === 'now' && c0.schedule.workingHours.enabled && c0.schedule.workingHours.start === '09:00' && c0.schedule.workingHours.end === '17:00' && c0.schedule.endAt === new Date(2026, 9, 12, 17, 0).toISOString() && c0.schedule.postsPerProfile === 3)
check('… run named after the schedule and day', c0.name === 'Weekday tips · 2026-10-12')
await svc.tick()
now = new Date(2026, 9, 12, 12, 0)
await svc.tick()
check('only once per day', starts.length === 1)
let s = svc.get(s1.id)
check('last run recorded; next run = tomorrow 09:00', s.lastRunDate === '2026-10-12' && s.lastRunId === 'run-1' && s.nextRunAt === new Date(2026, 9, 13, 9, 0).toISOString(), JSON.stringify([s.lastRunDate, s.nextRunAt]))

// another run active → waits; started once free (same day, still inside hours)
now = new Date(2026, 9, 13, 9, 1)
active = { id: 'manual', status: 'publishing', scheduleId: null } as AutomationRun
await svc.tick()
check('another automation is active → waits (one run at a time)', starts.length === 1)
active = null
now = new Date(2026, 9, 13, 10, 30)
await svc.tick()
check('… starts when it is free, still inside the hours', starts.length === 2 && localDate(now) === '2026-10-13')

// window passed without a run → noted once, no late run
now = new Date(2026, 9, 14, 17, 30)
await svc.tick()
s = svc.get(s1.id)
check('daily hours passed (app was closed) → no late run, a plain note', starts.length === 2 && s.lastRunDate === '2026-10-14' && (s.lastMessage ?? '').includes('Didn’t run on 2026-10-14'))

// a day not chosen
now = new Date(2026, 9, 17, 10, 0) // Saturday
await svc.tick()
check('a day that is not chosen (Saturday) → nothing', starts.length === 2)

// refused start → reported once, not retried all day
now = new Date(2026, 9, 19, 10, 0) // Monday
startError = new ValidationError('No profiles are synced from IX Browser yet. Sync profiles first.')
await svc.tick()
await svc.tick()
s = svc.get(s1.id)
check('refused start → note + one notification, no retry that day', starts.length === 2 && (s.lastMessage ?? '').includes('No profiles are synced') && notices.filter((n) => n.title === 'Scheduled automation didn’t start').length === 1)
startError = new ConflictError('Another automation run is still active.')
now = new Date(2026, 9, 20, 10, 0)
await svc.tick()
check('a conflict (run started meanwhile) is retried, not recorded as the day’s outcome', svc.get(s1.id).lastRunDate !== '2026-10-20')
startError = null
await svc.tick()
check('… and started on the retry', starts.length === 3)

// pause / resume (also pauses / resumes today's run of this schedule)
active = { id: 'run-3', status: 'generating', scheduleId: s1.id } as AutomationRun
let p = svc.pause(s1.id)
check('pause: schedule paused, its active run paused too', p.status === 'paused' && p.nextRunAt === null && paused.includes('run-3') && notices.some((n) => n.title === 'Automation schedule paused'))
now = new Date(2026, 9, 21, 10, 0)
active = null
await svc.tick()
check('paused schedule starts nothing', starts.length === 3)
active = { id: 'run-3', status: 'paused', scheduleId: s1.id } as AutomationRun
p = svc.resume(s1.id)
check('resume: active again, its paused run resumed', p.status === 'active' && resumed.includes('run-3'))
active = null
await svc.tick()
check('… and today’s run starts (inside the hours)', starts.length === 4)

// a run started by another schedule or by hand is never paused by this one
active = { id: 'other', status: 'generating', scheduleId: null } as AutomationRun
svc.pause(s1.id)
check('pausing a schedule leaves unrelated runs alone', !paused.includes('other'))
svc.resume(s1.id)
active = null

// end date
now = new Date(2026, 9, 24, 10, 0) // after 2026-10-23
await svc.tick()
s = svc.get(s1.id)
check('after the end date: ended, no run', s.status === 'ended' && starts.length === 4 && s.nextRunAt === null)
check('an ended schedule can’t be resumed until its dates change', (await errOf(() => svc.resume(s1.id))).includes('ended'))
const reopened = svc.save({ ...input({ endDate: '2026-11-30' }), id: s1.id })
check('changing the end date makes it active again', reopened.status === 'active' && reopened.nextRunAt !== null)

// starts in the future, every day
const s2 = svc.save(input({ name: 'Weekend', days: [0, 6], startDate: '2026-11-01', endDate: null, windowStart: '10:00', windowEnd: '12:00' }))
check('future start: next run on the first chosen day in range', s2.nextRunAt === new Date(2026, 10, 1, 10, 0).toISOString(), s2.nextRunAt ?? 'null')
svc.remove(s2.id)
check('removed', !svc.list().some((x) => x.id === s2.id))
check('runs keep their history after a schedule is removed (schedule_id cleared)', (() => { const id = svc.save(input({ name: 'Tmp', startDate: '2026-10-24', endDate: null })).id; db.run("INSERT INTO automation_runs (id, name, mode, status, config, schedule_id, created_at, updated_at) VALUES ('keep', 'r', 'full-auto', 'completed', '{}', :s, :at, :at)", { s: id, at: now.toISOString() }); svc.remove(id); return db.get<{ schedule_id: string | null }>("SELECT schedule_id FROM automation_runs WHERE id = 'keep'")?.schedule_id === null })())

db.close()
console.log(results.join('\n'))
console.log(`\n${results.filter((x) => x.startsWith('FAIL')).length} failed of ${results.length}`)
process.exit(0)
