// Phase 8 unit tests: queue, scheduler, publishing workflow and publish handler classification.
// The engine and IX Browser are scripted fakes here (the real engine is covered by
// engine/tests/test_x_publish.py and the e2e suite).
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
const SRC = '../../src/main/services'
import { SqliteDatabase } from '../../src/main/services/database/driver'
import { migrate } from '../../src/main/services/database/migrator'
import { createSqliteRepositories } from '../../src/main/services/database/sqlite'
import { AccountRepository } from '../../src/main/services/database/sqlite/accountRepository'
import { AssetRepository } from '../../src/main/services/database/sqlite/assetRepository'
import { PostLinkRepository } from '../../src/main/services/database/sqlite/postLinkRepository'
import { QueueRepository } from '../../src/main/services/database/sqlite/queueRepository'
import { ScheduleRepository } from '../../src/main/services/database/sqlite/scheduleRepository'
import { DraftService } from '../../src/main/services/drafts/draftService'
import { EngineError } from '../../src/main/services/engine/engineService'
import { Notifier } from '../../src/main/services/notifications/notifier'
import { PublishHandler } from '../../src/main/services/publishing/publishHandler'
import { PublishingService } from '../../src/main/services/publishing/publishingService'
import { parsePostUrl } from '../../src/main/services/publishing/postUrl'
import { Scheduler } from '../../src/main/services/publishing/scheduler'
import { QueueService } from '../../src/main/services/queue/queueService'
void SRC

const results: string[] = []
const check = (name: string, ok: boolean, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + String(extra).slice(0, 300) : ''}`)
const logged: string[] = []
const log = {
  debug() {},
  info: (m: string, meta?: unknown) => logged.push(m + JSON.stringify(meta ?? {})),
  success: (m: string, meta?: unknown) => logged.push(m + JSON.stringify(meta ?? {})),
  warn: (m: string, meta?: unknown) => logged.push(m + JSON.stringify(meta ?? {})),
  error: (m: string, e?: unknown) => logged.push(m + String(e))
}
const errOf = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === 'function' ? p() : p)
    return 'none'
  } catch (e) {
    return `${(e as Error).name}: ${(e as Error).message}`
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (fn: () => boolean, ms = 4000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await sleep(20)
  }
  return false
}

const file = process.argv[2]!
rmSync(file, { force: true })
const db = new SqliteDatabase(file).open()
check('migrate → v13', migrate(db, log as never) === 13)
const at = new Date().toISOString()
db.exec(`INSERT INTO browser_profiles (id, external_id, name, synced_at, first_seen_at, availability, run_state) VALUES
  ('bp1','101','Alpha','${at}','${at}','available','closed'),('bp2','102','Beta','${at}','${at}','available','closed'),('bp3','103','Gamma','${at}','${at}','available','running')`)
db.exec(`INSERT INTO accounts (id, label, handle, identity, identity_confirmed_at, browser_profile_id, linked_at, enabled, created_at, updated_at) VALUES
  ('11111111-1111-4111-8111-111111111111','Main','relay_main','confirmed','${at}','bp1','${at}',1,'${at}','${at}'),
  ('22222222-2222-4222-8222-222222222222','Second',NULL,'unknown',NULL,'bp2','${at}',1,'${at}','${at}'),
  ('33333333-3333-4333-8333-333333333333','Disabled','relay_off','confirmed','${at}',NULL,NULL,0,'${at}','${at}'),
  ('44444444-4444-4444-8444-444444444444','Busy','relay_busy','confirmed','${at}','bp3','${at}',1,'${at}','${at}')`)
const MAIN = '11111111-1111-4111-8111-111111111111'
const SECOND = '22222222-2222-4222-8222-222222222222'
const DISABLED = '33333333-3333-4333-8333-333333333333'
const BUSY = '44444444-4444-4444-8444-444444444444'

const repos = createSqliteRepositories(db)
const assetRepo = new AssetRepository(db)
const drafts = new DraftService(repos, db, assetRepo, log as never)
const accounts = new AccountRepository(db)
const queueRepo = new QueueRepository(db)
const schedules = new ScheduleRepository(db)
const postLinks = new PostLinkRepository(db)

const notices: { title: string; tone: string; body?: string }[] = []
const prefs = { notifications: { taskFailures: { inApp: true, desktop: false }, scheduleReminders: { inApp: true, desktop: false }, systemNotices: { inApp: true, desktop: false } } }
const notifier = new Notifier({ preferences: { get: () => prefs } as never, log: log as never })
notifier.attach((n) => notices.push(n))
notifier.rendererListening()

// Fake IX Browser: profiles open with a debugging address.
const ix = {
  addresses: new Map<number, string>(),
  opened: [] as number[],
  closed: [] as number[],
  failOpen: false,
  debuggingAddressFor(ext: number) {
    return this.addresses.get(ext) ?? null
  },
  async openProfile(ext: number) {
    if (this.failOpen) throw new Error('IX down')
    this.opened.push(ext)
    this.addresses.set(ext, `127.0.0.1:${9000 + ext}`)
  },
  async closeProfile(ext: number) {
    this.closed.push(ext)
    this.addresses.delete(ext)
  }
}
// Scripted engine: each call takes the next behaviour from the script.
type Behaviour = (params: Record<string, unknown>, progress: (s: string) => void) => Promise<Record<string, unknown>>
let postSeq = 1
const okReply = (handle = 'relay_main'): Behaviour => async (_p, progress) => {
  for (const s of ['attach', 'open-composer', 'write', 'submit', 'confirm']) progress(s)
  const id = String(1800000000000000000n + BigInt(postSeq++))
  return { url: `https://x.com/${handle}/status/${id}`, postId: id, handle, accountCheck: 'match' }
}
const failWith = (code: string, opts: { submitted?: boolean; upTo?: string } = {}): Behaviour => async (_p, progress) => {
  const stages = ['attach', 'open-composer', 'write', 'submit', 'confirm']
  for (const s of stages.slice(0, opts.upTo ? stages.indexOf(opts.upTo) + 1 : 1)) progress(s)
  throw new EngineError(code, `engine says ${code}`, false, opts.submitted ?? null)
}
const engine = {
  script: [] as Behaviour[],
  calls: [] as Record<string, unknown>[],
  finds: [] as Record<string, unknown>[],
  findReply: { found: false } as Record<string, unknown>,
  killed: 0,
  async request(cmd: string, params: Record<string, unknown>, opts: { onProgress?: (s: string) => void }) {
    // x.findPost is the profile check after an unconfirmed submit; it is tracked separately.
    if (cmd === 'x.findPost') {
      this.finds.push(params)
      return this.findReply
    }
    this.calls.push(params)
    const next = this.script.shift() ?? okReply()
    return next(params, opts.onProgress ?? (() => {}))
  },
  killNow() {
    this.killed++
  }
}

const queue = new QueueService({ repo: queueRepo, log: log as never, onChange() {}, backoffMs: () => 60 })
const publishing = new PublishingService({
  db,
  drafts: repos.drafts,
  accounts,
  schedules,
  postLinks,
  queue,
  duplicateDraft: (id) => drafts.duplicate(id),
  settings: repos.settings,
  activity: repos.activity,
  notifier,
  log: log as never,
  onChange() {}
})
publishing.updateSettings({ spacingMinutes: 0, missedGraceMinutes: 15 })
queue.register(
  new PublishHandler({
    drafts: repos.drafts,
    accounts,
    postLinks,
    queueRepo,
    ixBrowser: ix as never,
    engine: engine as never,
    assetFile: () => '/tmp/x.png',
    settings: () => publishing.getSettings(),
    settle: (t, s) => publishing.settleTask(t, s),
    log: log as never
  })
)
const scheduler = new Scheduler({ db, schedules, accounts, publishing, settings: () => publishing.getSettings(), notifier, log: log as never, onChange() {} })

const draft = async (body: string, accountId: string | null = MAIN) => drafts.save({ body, accountId, status: 'ready' })
const task = (id: string) => queueRepo.get(id)!
const sched = (id: string) => schedules.get(id)!
const draftStatus = async (id: string) => (await repos.drafts.get(id))!.status
const soon = (ms: number) => new Date(Date.now() + ms).toISOString()
const taskFor = (scheduleId: string) => db.get<{ id: string }>('SELECT id FROM tasks WHERE schedule_id = :id ORDER BY created_at DESC LIMIT 1', { id: scheduleId })?.id ?? ''

// ── post URLs ──
check('post URL parsing', parsePostUrl('https://twitter.com/Relay_Main/status/123?s=20')?.url === 'https://x.com/Relay_Main/status/123' && parsePostUrl('x.com/i/web/status/99')?.handle === null && parsePostUrl('https://evil.com/a/status/1') === null && parsePostUrl('https://x.com/relay_main') === null && parsePostUrl('https://x.com:8443/a/status/1') === null)

// ── checks ──
const d0 = await draft('Hello from the scheduler 🗓️')
let c = await publishing.check(d0.id, null)
check('check: no account is blocking', !c.ok && c.problems.some((p) => p.code === 'no-account' && p.blocking))
c = await publishing.check(d0.id, DISABLED)
check('check: disabled + unlinked account blocking', !c.ok && c.problems.some((p) => p.code === 'account-disabled') && c.problems.some((p) => p.code === 'not-linked'))
c = await publishing.check(d0.id, SECOND)
check('check: unconfirmed username is a warning only', c.ok && c.problems.some((p) => p.code === 'handle-unknown' && !p.blocking))
c = await publishing.check(d0.id, MAIN, new Date(Date.now() - 3_600_000).toISOString())
check('check: time in the past is blocking', !c.ok && c.problems.some((p) => p.code === 'in-past'))
const long = await draft('a'.repeat(300))
c = await publishing.check(long.id, MAIN)
check('check: >280 is a Premium warning, not blocking', c.ok && c.problems.some((p) => p.code === 'premium-length' && !p.blocking))

// ── schedule locks the draft ──
const e1 = await publishing.schedule({ draftId: d0.id, accountId: MAIN, runAt: soon(3_600_000) })
check('schedule: pending, draft scheduled', e1.schedule.status === 'pending' && (await draftStatus(d0.id)) === 'scheduled' && e1.account?.label === 'Main')
check('scheduled draft cannot be edited', (await errOf(drafts.save({ id: d0.id, body: 'changed', accountId: MAIN }))).includes('can no longer be edited'))
check('scheduled draft cannot be deleted', (await errOf(drafts.remove(d0.id))).includes('Cancel the schedule first'))
check('draft cannot be scheduled twice', (await errOf(publishing.schedule({ draftId: d0.id, accountId: MAIN, runAt: soon(7_200_000) }))).includes('already scheduled'))
await publishing.unschedule(e1.schedule.id)
check('unschedule: cancelled, draft back to ready', sched(e1.schedule.id).status === 'cancelled' && (await draftStatus(d0.id)) === 'ready')

// ── due → queued → published ──
const e2 = await publishing.schedule({ draftId: d0.id, accountId: MAIN, runAt: soon(1_500) })
check('reschedule after cancel works (new schedule)', e2.schedule.status === 'pending')
queue.start()
await sleep(1_700)
scheduler.tick()
scheduler.tick() // a second tick must not queue it again
const t2 = taskFor(e2.schedule.id)
check('due schedule queued exactly once', db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE schedule_id = :id', { id: e2.schedule.id })?.n === 1)
check('published', await waitFor(() => task(t2).status === 'succeeded'), task(t2)?.status)
const link2 = postLinks.byTask(t2)
check('schedule completed, draft published, link recorded with preview', sched(e2.schedule.id).status === 'completed' && (await draftStatus(d0.id)) === 'published' && Boolean(link2?.url.startsWith('https://x.com/relay_main/status/')) && link2?.preview.startsWith('Hello from the scheduler') === true)
check('engine got the composed text, expected handle and media list', engine.calls.at(-1)?.text === 'Hello from the scheduler 🗓️' && engine.calls.at(-1)?.expectedHandle === 'relay_main' && Array.isArray(engine.calls.at(-1)?.media))
check('profile opened for publishing and closed again', ix.opened.includes(101) && ix.closed.includes(101))
check('success notice', notices.some((n) => n.title === 'Post published' && n.tone === 'success'))
check('attempt stages recorded in plain language', queue.details(t2).runs.at(-1)?.stage === 'Confirming on X' && queue.details(t2).runs.at(-1)?.status === 'succeeded')
check('published draft cannot be scheduled again', (await errOf(publishing.schedule({ draftId: d0.id, accountId: MAIN, runAt: soon(60_000) }))).includes('already been published'))

// ── safe retry before submit ──
const d3 = await draft('Retry me')
engine.script = [failWith('CONNECT_FAILED'), okReply()]
const callsBefore = engine.calls.length
const e3 = await publishing.publishNow({ draftId: d3.id, accountId: MAIN })
const t3 = taskFor(e3.schedule.id)
check('connect failure retried, then published', await waitFor(() => task(t3).status === 'succeeded'), task(t3)?.status)
check('exactly two attempts, one link', engine.calls.length - callsBefore === 2 && queue.details(t3).runs.length === 2 && queue.details(t3).runs[0]!.status === 'failed' && db.get<{ n: number }>('SELECT COUNT(*) AS n FROM post_links WHERE task_id = :id', { id: t3 })?.n === 1)

// ── uncertain outcome → review, never retried ──
const d4 = await draft('Did it post?')
engine.script = [failWith('OUTCOME_UNKNOWN', { submitted: true, upTo: 'confirm' })]
const before4 = engine.calls.length
const e4 = await publishing.publishNow({ draftId: d4.id, accountId: MAIN })
const t4 = taskFor(e4.schedule.id)
check('unconfirmed post → needs review', await waitFor(() => task(t4).status === 'needs-review'), task(t4)?.status)
await sleep(300)
check('… and is not retried', engine.calls.length - before4 === 1 && task(t4).status === 'needs-review')
check('… after a profile check for the exact text', engine.finds.at(-1)?.text === 'Did it post?' && engine.finds.at(-1)?.handle === 'relay_main', JSON.stringify(engine.finds.at(-1)))

// ── uncertain outcome, but the profile check finds the post → succeeded (verified by profile check), no retry ──
const d4b = await draft('Found on profile')
engine.script = [failWith('OUTCOME_UNKNOWN', { submitted: true, upTo: 'confirm' })]
engine.findReply = { found: true, url: 'https://x.com/relay_main/status/1799999999999999999', postId: '1799999999999999999', handle: 'relay_main' }
const before4b = engine.calls.length
const e4b = await publishing.publishNow({ draftId: d4b.id, accountId: MAIN })
const t4b = taskFor(e4b.schedule.id)
check('unconfirmed but found on profile → succeeded', await waitFor(() => task(t4b).status === 'succeeded'), task(t4b)?.status)
check('… one publish attempt, link recorded as profile-check', engine.calls.length - before4b === 1 && db.get<{ n: number }>("SELECT COUNT(*) AS n FROM post_links WHERE task_id = :id AND url LIKE '%1799999999999999999'", { id: t4b })?.n === 1)
engine.findReply = { found: false }
check('schedule needs review, draft stays locked', sched(e4.schedule.id).status === 'needs-review' && (await draftStatus(d4.id)) === 'scheduled')
check('attention notice (plain language)', notices.some((n) => n.title === 'Publishing outcome needs review' && !/OUTCOME_UNKNOWN|engine says/.test(n.body ?? '')))
check('retry refused while awaiting review', (await errOf(() => publishing.retryTask(t4))).includes('Check whether this already happened'))
check('unschedule refused while awaiting review', (await errOf(publishing.unschedule(e4.schedule.id))).includes('Check on X'))
publishing.resolveReview({ taskId: t4, outcome: 'not-posted' })
check('resolved "not posted" → failed, draft failed', task(t4).status === 'failed' && (await draftStatus(d4.id)) === 'failed' && sched(e4.schedule.id).status === 'failed')
publishing.retryTask(t4)
check('user retry after confirming → published', await waitFor(() => task(t4).status === 'succeeded'), task(t4)?.status)

// review resolved as posted with a link
const d5 = await draft('Posted but unconfirmed')
engine.script = [failWith('ENGINE_CRASHED', { upTo: 'submit' })]
const e5 = await publishing.publishNow({ draftId: d5.id, accountId: MAIN })
const t5 = taskFor(e5.schedule.id)
check('engine crash after the submit step → review (not retry)', await waitFor(() => task(t5).status === 'needs-review'), task(t5)?.status)
check('invalid link refused', (await errOf(() => publishing.resolveReview({ taskId: t5, outcome: 'posted', url: 'https://example.com/x' }))).includes('not a link to a post'))
publishing.resolveReview({ taskId: t5, outcome: 'posted', url: 'https://twitter.com/relay_main/status/42' })
check('resolved "posted" with link → published + link saved', task(t5).status === 'succeeded' && task(t5).result?.verifiedBy === 'user' && postLinks.byUrlOrPostId('https://x.com/relay_main/status/42', '42') !== null && (await draftStatus(d5.id)) === 'published')

// crash before the submit step is safe to retry
const d6 = await draft('Crash early')
engine.script = [failWith('ENGINE_CRASHED', { upTo: 'write' }), okReply()]
const e6 = await publishing.publishNow({ draftId: d6.id, accountId: MAIN })
const t6 = taskFor(e6.schedule.id)
check('engine crash before submit → retried and published', await waitFor(() => task(t6).status === 'succeeded'), task(t6)?.status)

// engine timeout → review and the engine is stopped
const d7 = await draft('Hung engine')
engine.script = [failWith('ENGINE_TIMEOUT', { upTo: 'attach' })]
const killed = engine.killed
const t7 = taskFor((await publishing.publishNow({ draftId: d7.id, accountId: MAIN })).schedule.id)
check('engine timeout → review, engine stopped', (await waitFor(() => task(t7).status === 'needs-review')) && engine.killed === killed + 1)

// rejection and definite failures are not retried
const d8 = await draft('Rejected')
engine.script = [failWith('REJECTED', { submitted: true, upTo: 'confirm' })]
const t8 = taskFor((await publishing.publishNow({ draftId: d8.id, accountId: MAIN })).schedule.id)
check('X rejection → failed (not retried, not review)', (await waitFor(() => task(t8).status === 'failed')) && queue.details(t8).runs.length === 1 && (await draftStatus(d8.id)) === 'failed')
check('failure notice explains in plain words', notices.some((n) => n.title === 'A post could not be published' && n.body === 'X did not accept the post, so it was not published.'))

const d9 = await draft('Signed out 1')
const d10 = await draft('Signed out 2')
engine.script = [failWith('SESSION_EXPIRED'), failWith('SESSION_EXPIRED')]
const n0 = notices.filter((n) => n.title === 'A post could not be published').length
const t9 = taskFor((await publishing.publishNow({ draftId: d9.id, accountId: MAIN })).schedule.id)
await waitFor(() => task(t9).status === 'failed')
const t10 = taskFor((await publishing.publishNow({ draftId: d10.id, accountId: MAIN })).schedule.id)
await waitFor(() => task(t10).status === 'failed')
check('signed-out profile → failed with guidance, no retry', task(t9).error === 'This profile is signed out of X. Sign in to X in IX Browser, then retry.' && queue.details(t9).runs.length === 1)
check('the same continuing failure is notified once', notices.filter((n) => n.title === 'A post could not be published').length - n0 === 1)

// ── return failed draft to editing ──
await publishing.returnToDrafts(d9.id)
check('failed draft returned to drafts (editable again)', (await draftStatus(d9.id)) === 'ready' && (await errOf(drafts.save({ id: d9.id, body: 'Edited after failure', accountId: MAIN }))) === 'none')

// ── posted from another account ──
const d11 = await draft('Wrong account')
engine.script = [okReply('someone_else')]
const t11 = taskFor((await publishing.publishNow({ draftId: d11.id, accountId: MAIN })).schedule.id)
await waitFor(() => task(t11).status === 'succeeded')
check('different handle in the post link → success + warning notice', notices.some((n) => n.title === 'Posted from a different account'))

// ── profile open in IX Browser but not by us → retry later ──
const d12 = await draft('Profile busy')
const t12 = taskFor((await publishing.publishNow({ draftId: d12.id, accountId: BUSY })).schedule.id)
check('profile opened elsewhere → safe retry with guidance', await waitFor(() => task(t12).status === 'failed' && queue.details(t12).runs.length === 3), `${task(t12)?.status} ${queue.details(t12).runs.length}`)
check('… message tells the user what to do', (task(t12).error ?? '').includes('Close it there'))

// ── cancel ──
const d13 = await draft('Cancel me')
const e13 = await publishing.schedule({ draftId: d13.id, accountId: MAIN, runAt: soon(3_600_000) })
publishing.enqueue(sched(e13.schedule.id))
const t13 = taskFor(e13.schedule.id)
check('cancel waiting task', queue.cancel(t13) === 'cancelled' && task(t13).status === 'cancelled' && sched(e13.schedule.id).status === 'cancelled' && (await draftStatus(d13.id)) === 'ready')

// cancel while running, before the engine is asked
const d14 = await draft('Cancel while opening')
let releaseOpen: () => void = () => {}
const originalOpen = ix.openProfile
ix.openProfile = async function (ext: number) {
  await new Promise<void>((r) => (releaseOpen = r))
  this.opened.push(ext)
  this.addresses.set(ext, `127.0.0.1:${9000 + ext}`)
}
const calls14 = engine.calls.length
const t14 = taskFor((await publishing.publishNow({ draftId: d14.id, accountId: SECOND })).schedule.id)
await waitFor(() => task(t14).status === 'running')
check('cancel running task → stopping', queue.cancel(t14) === 'stopping')
releaseOpen()
check('… stopped before anything was posted', (await waitFor(() => task(t14).status === 'cancelled')) && engine.calls.length === calls14 && (await draftStatus(d14.id)) === 'ready')
ix.openProfile = originalOpen

// ── spacing between posts of one account ──
publishing.updateSettings({ spacingMinutes: 1 })
const d15 = await draft('Spaced')
const t15 = taskFor((await publishing.publishNow({ draftId: d15.id, accountId: MAIN })).schedule.id)
await sleep(200)
const last = queueRepo.lastPublishAt(MAIN)!
check('next post of the same account waits for the spacing', task(t15).status === 'queued' && new Date(task(t15).runAfter).getTime() >= new Date(last).getTime() + 59_000, task(t15).runAfter)
queue.cancel(t15)
publishing.updateSettings({ spacingMinutes: 0 })

// ── crash recovery: a publish task left running by a shutdown ──
await queue.stop()
const d16 = await draft('Interrupted')
const e16 = await publishing.schedule({ draftId: d16.id, accountId: MAIN, runAt: soon(3_600_000) })
const t16 = publishing.enqueue(sched(e16.schedule.id)).id
db.run("UPDATE tasks SET status = 'running', attempts = 1, started_at = :at WHERE id = :id", { id: t16, at })
db.run("INSERT INTO task_runs (id, task_id, attempt, status, started_at) VALUES ('r-int', :id, 1, 'running', :at)", { id: t16, at })
const calls16 = engine.calls.length
const queue2 = new QueueService({ repo: queueRepo, log: log as never, onChange() {} })
queue2.register(new PublishHandler({ drafts: repos.drafts, accounts, postLinks, queueRepo, ixBrowser: ix as never, engine: engine as never, assetFile: () => '/tmp/x.png', settings: () => publishing.getSettings(), settle: (t, s) => publishing.settleTask(t, s), log: log as never }))
queue2.onSettled(() => {})
queue2.start()
await sleep(200)
check('interrupted publish → needs review, never re-run', task(t16).status === 'needs-review' && engine.calls.length === calls16 && sched(e16.schedule.id).status === 'needs-review')
check('interrupted attempt closed as uncertain', queue2.details(t16).runs[0]?.status === 'uncertain')
await queue2.stop()

// ── missed slots ──
const d17 = await draft('Missed while closed')
const missedId = '99999999-9999-4999-8999-999999999999'
db.run("INSERT INTO scheduled_posts (id, draft_id, account_id, run_at, status, created_at, updated_at) VALUES (:id, :d, :a, :r, 'pending', :at, :at)", { id: missedId, d: d17.id, a: MAIN, r: new Date(Date.now() - 2 * 3_600_000).toISOString(), at })
db.run("UPDATE drafts SET status = 'scheduled' WHERE id = :id", { id: d17.id })
const d18 = await draft('Queued but stale')
const stale = await publishing.schedule({ draftId: d18.id, accountId: MAIN, runAt: soon(60_000) })
const tStale = publishing.enqueue(sched(stale.schedule.id)).id
db.run('UPDATE scheduled_posts SET run_at = :r WHERE id = :id', { id: stale.schedule.id, r: new Date(Date.now() - 3 * 3_600_000).toISOString() })
db.run('UPDATE tasks SET run_after = :r WHERE id = :id', { id: tStale, r: new Date(Date.now() - 3 * 3_600_000).toISOString() })
const missedNotices = notices.length
scheduler.prepare()
check('slot missed beyond grace → missed (not published late)', sched(missedId).status === 'missed' && taskFor(missedId) === '')
check('stale queued post withdrawn → missed', task(tStale).status === 'cancelled' && sched(stale.schedule.id).status === 'missed')
check('one missed notice for both', notices.length - missedNotices === 1 && notices.at(-1)!.title === '2 scheduled posts were missed')
queue.start()
await publishing.resolveMissed(missedId, { action: 'publish-now' })
const tMissed = taskFor(missedId)
check('missed → publish now → published', await waitFor(() => task(tMissed)?.status === 'succeeded'), JSON.stringify({ t: task(tMissed), runs: tMissed && queue.details(tMissed).runs }))
await publishing.resolveMissed(stale.schedule.id, { action: 'reschedule', runAt: soon(3_600_000) })
check('missed → rescheduled', sched(stale.schedule.id).status === 'pending' && (await draftStatus(d18.id)) === 'scheduled')

// ── reminders ──
publishing.updateSettings({ reminderMinutes: 120 })
const remindersBefore = notices.filter((n) => n.title.startsWith('Post going out')).length
scheduler.tick()
scheduler.tick()
check('reminder sent once per schedule', notices.filter((n) => n.title.startsWith('Post going out')).length - remindersBefore === 1 && !notices.at(-1)!.body!.includes('Queued but stale'))

// ── handler never publishes twice for a task with a recorded link ──
const handler = new PublishHandler({ drafts: repos.drafts, accounts, postLinks, queueRepo, ixBrowser: ix as never, engine: engine as never, assetFile: () => '/tmp/x.png', settings: () => publishing.getSettings(), settle() {}, log: log as never })
const callsDup = engine.calls.length
const dup = await handler.run(task(t2), { signal: new AbortController().signal, attempt: 2, stage() {} })
check('task with a recorded link is not published again', dup?.url === link2?.url && engine.calls.length === callsDup)

// ── one manual post from several accounts ──
{
  const errOf = async (p: Promise<unknown>) => { try { await p; return 'none' } catch (e) { return (e as Error).message } }
  const imgId = randomUUID()
  assetRepo.insert({ id: imgId, origin: 'upload', originalName: 'pic.png', filePath: `2026-10/${imgId}.png`, mimeType: 'image/png', width: 10, height: 10, sizeBytes: 100, sha256: imgId.replace(/-/g, ''), animated: false, prompt: null, generationId: null, kept: true, createdAt: new Date().toISOString() })
  const multi = await drafts.save({ body: 'Same news, two accounts', hashtags: ['launch'], accountId: MAIN, status: 'ready', attachments: [{ assetId: imgId, altText: '' }] })
  const later = new Date(Date.now() + 3 * 3600_000).toISOString()
  const draftsBefore = (await repos.drafts.list()).length
  check('multi-account: the same text needs explicit permission', (await errOf(publishing.scheduleMany({ draftId: multi.id, accountIds: [MAIN, SECOND], runAt: later, allowSameText: false }))).includes('same text'))
  check('multi-account: one blocked account stops everything (nothing copied or scheduled)', (await errOf(publishing.scheduleMany({ draftId: multi.id, accountIds: [MAIN, DISABLED], runAt: later, allowSameText: true }))).includes('disabled') && (await repos.drafts.list()).length === draftsBefore && !schedules.activeForDraft(multi.id))
  const res = await publishing.scheduleMany({ draftId: multi.id, accountIds: [MAIN, SECOND, MAIN], runAt: later, allowSameText: true })
  const copyId = res.entries[1]?.schedule.draftId
  const copy = copyId ? await repos.drafts.get(copyId) : null
  check('multi-account: draft → first account, independent copy → second (duplicates in the list ignored)', res.entries.length === 2 && res.failed.length === 0 && res.entries[0]!.schedule.draftId === multi.id && res.entries[0]!.schedule.accountId === MAIN && res.entries[1]!.schedule.accountId === SECOND && copyId !== multi.id, JSON.stringify(res.failed))
  check('… the copy has the same text, hashtags and image', copy?.body === multi.body && copy.hashtags.join() === 'launch' && copy.media.length === 1 && copy.media[0]!.id === imgId)
  check('… each has its own pending schedule, both drafts locked', schedules.activeForDraft(multi.id)?.status === 'pending' && schedules.activeForDraft(copyId!)?.status === 'pending' && (await draftStatus(multi.id)) === 'scheduled' && (await draftStatus(copyId!)) === 'scheduled')
  const now2 = await drafts.save({ body: 'Publish now from two accounts', accountId: MAIN, status: 'ready' })
  const callsBefore = engine.calls.length
  const res2 = await publishing.scheduleMany({ draftId: now2.id, accountIds: [MAIN, SECOND], runAt: null, allowSameText: true })
  check('multi-account publish now: both queued and published, one engine call each', res2.entries.length === 2 && (await waitFor(() => res2.entries.every((e) => schedules.get(e.schedule.id)!.status === 'completed'), 8000)) && engine.calls.length - callsBefore === 2 && engine.calls.slice(-2).every((c) => String(c.text).startsWith('Publish now from two accounts')))
}

// ── settings validation ──
check('settings validated', (await errOf(() => publishing.updateSettings({ spacingMinutes: -1 }))).includes('between 0 and 1440'))

// ── privacy ──
const texts = ['Hello from the scheduler', 'Did it post', 'Wrong account', 'Signed out']
check('logs never contain post text', !logged.some((l) => texts.some((t) => l.includes(t))), logged.find((l) => texts.some((t) => l.includes(t))) ?? '')

await queue.stop()
db.close()
console.log(results.join('\n'))
console.log(`\n${results.filter((x) => x.startsWith('FAIL')).length} failed of ${results.length}`)
process.exit(0)
