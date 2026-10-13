// Multi-account campaigns: every selected post is published from every eligible linked account.
// The config is the one the Campaigns form sends (shared/lib/campaign.ts); runs, drafts, publishing,
// queue and database are the real services. The publish handler is scripted (the engine path is covered
// by engine/tests and the end-to-end suite).
import { rmSync } from 'node:fs'
import { SqliteDatabase } from '../../src/main/services/database/driver'
import { migrate } from '../../src/main/services/database/migrator'
import { createSqliteRepositories } from '../../src/main/services/database/sqlite'
import { AccountRepository } from '../../src/main/services/database/sqlite/accountRepository'
import { AssetRepository } from '../../src/main/services/database/sqlite/assetRepository'
import { EngagementRepository } from '../../src/main/services/database/sqlite/engagementRepository'
import { PostLinkRepository } from '../../src/main/services/database/sqlite/postLinkRepository'
import { ProfileRepository } from '../../src/main/services/database/sqlite/profileRepository'
import { QueueRepository } from '../../src/main/services/database/sqlite/queueRepository'
import { ScheduleRepository } from '../../src/main/services/database/sqlite/scheduleRepository'
import { RunService } from '../../src/main/services/automation/runService'
import { DraftService } from '../../src/main/services/drafts/draftService'
import { EngagementService } from '../../src/main/services/links/engagementService'
import { Notifier } from '../../src/main/services/notifications/notifier'
import { PublishingService } from '../../src/main/services/publishing/publishingService'
import { QueueService } from '../../src/main/services/queue/queueService'
import { TaskError } from '../../src/main/services/queue/types'
import { defaultChoices, toConfig } from '../../src/shared/lib/campaign'

const results: string[] = []
const check = (name: string, ok: boolean, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + String(extra).slice(0, 300) : ''}`)
const log = { debug() {}, info() {}, success() {}, warn() {}, error() {} }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (fn: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await sleep(20)
  }
  return false
}
const errOf = async (p: Promise<unknown>) => p.then(() => 'none', (e: Error) => e.message)

const file = process.argv[2]!
for (const s of ['', '-wal', '-shm']) rmSync(file + s, { force: true })
const db = new SqliteDatabase(file).open()
check('migrate → v15', migrate(db, log as never) === 15)

// 10 linked accounts on 10 available profiles (as automatic linking leaves them), plus one unavailable
// profile and one disabled account that must be left out.
const at = new Date().toISOString()
const ACC = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const PROF = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`
for (let n = 1; n <= 12; n++) {
  db.run("INSERT INTO browser_profiles (id, external_id, name, synced_at, first_seen_at, availability, run_state) VALUES (:id, :ext, :name, :at, :at, :avail, 'closed')", { id: PROF(n), ext: String(100 + n), name: `Profile ${n}`, at, avail: n === 11 ? 'unavailable' : 'available' })
  db.run("INSERT INTO accounts (id, label, identity, browser_profile_id, linked_at, enabled, created_at, updated_at) VALUES (:id, :label, 'unknown', :pid, :at, :enabled, :at, :at)", { id: ACC(n), label: `Account ${n}`, pid: PROF(n), at, enabled: n === 12 ? 0 : 1 })
}
const eligible = Array.from({ length: 10 }, (_, i) => ACC(i + 1))

const repos = createSqliteRepositories(db)
const assets = new AssetRepository(db)
const drafts = new DraftService(repos, db, assets, log as never)
const accounts = new AccountRepository(db)
const profiles = new ProfileRepository(db)
const queueRepo = new QueueRepository(db)
const prefs = { notifications: { taskFailures: { inApp: true, desktop: false }, scheduleReminders: { inApp: true, desktop: false }, systemNotices: { inApp: true, desktop: false } }, defaults: { textProviderId: null, imageProviderId: null } }
const notifier = new Notifier({ preferences: { get: () => prefs } as never, log: log as never })
notifier.attach(() => {})
notifier.rendererListening()
const queue = new QueueService({ repo: queueRepo, settings: repos.settings, log: log as never, onChange() {}, backoffMs: () => 20, concurrency: 4 })
const postLinks = new PostLinkRepository(db)
const publishing = new PublishingService({ db, drafts: repos.drafts, accounts, schedules: new ScheduleRepository(db), postLinks, queue, queueRepo, duplicateDraft: (id) => drafts.duplicate(id), settings: repos.settings, activity: repos.activity, notifier, log: log as never, onChange() {} })
publishing.updateSettings({ spacingMinutes: 0, maxAttempts: 2 })

// Scripted publisher: records which account posted which text; one account can be made to fail.
const posted: { accountId: string; text: string }[] = []
let failing: string | null = null
let seq = 0
queue.register({
  kind: 'publish',
  idempotent: false,
  async run(task) {
    if (task.accountId === failing) throw new TaskError('SESSION_EXPIRED', 'This profile is signed out of X.', 'fail')
    const draft = await repos.drafts.get(task.draftId!)
    posted.push({ accountId: task.accountId!, text: draft!.body })
    const id = String(1_900_000_000_000_000_000n + BigInt(++seq))
    return { url: `https://x.com/acct${task.accountId!.slice(-2)}/status/${id}`, postId: id, handle: `acct${task.accountId!.slice(-2)}`, verifiedBy: 'post-link' }
  },
  settle: (t, s) => publishing.settleTask(t, s)
} as never)
queue.start()

const engagement = new EngagementService({ repo: new EngagementRepository(db), links: postLinks, accounts, settings: repos.settings, ixBrowser: {} as never, engine: {} as never, log: log as never, onChange() {} })
const runs = new RunService({
  db,
  generator: {} as never,
  images: {} as never,
  drafts,
  assets,
  accounts,
  accountService: { createFromProfiles: () => ({ changed: 0, skipped: [], accounts: [] }) } as never,
  profiles,
  providers: { list: () => [] } as never,
  preferences: { get: () => prefs } as never,
  publishing,
  engagement,
  queue,
  notifier,
  log: log as never,
  onChange() {}
})
const campaign = (draftIds: string[], when: 'now' | 'schedule' = 'now', startAt: string | null = null) => toConfig({ ...defaultChoices(), name: 'Launch', action: 'post', draftIds, when, startAt })
const save = (body: string) => drafts.save({ body, accountId: null })
const items = (runId: string) => runs.details(runId).items.filter((i) => i.kind === 'post')
const runCompleted = (runId: string) => runs.details(runId).run.status === 'completed'

// ── 1. The config the form sends: every post on every account ──
const cfg = campaign(['x'])
check('the Campaigns form sends "every post from every profile" (no sharing out, no account picker)', cfg.targets.scope === 'all' && cfg.targets.distribution === 'same' && cfg.targets.allowDuplicates && cfg.targets.profileIds.length === 0)
check('… and one failing account never pauses the others (no stop-after-failures)', cfg.failure.stopAfterFailures === 0)

// ── 2. 3 posts × 10 accounts = 30 tasks ──
const p = [await save('Post one'), await save('Post two'), await save('Post three')]
const plan = runs.plan(campaign(p.map((d) => d.id)))
check('plan: 3 selected posts × 10 eligible accounts = 30 posts', plan.ok && plan.posts === 30 && plan.fromDrafts === 3 && plan.profiles.eligible === 10, JSON.stringify({ ok: plan.ok, posts: plan.posts, fromDrafts: plan.fromDrafts, eligible: plan.profiles.eligible, problems: plan.problems }))
check('plan: the unavailable profile and the disabled account are left out', plan.targets.filter((t) => !t.eligible).length === 2)
check('plan: the repeated-content risk is shown as a warning, not a block', plan.problems.some((x) => !x.blocking && x.message.includes('repeated content')))

const run1 = await runs.start(campaign(p.map((d) => d.id)))
check('a second start with the same posts is refused (no duplicate campaign)', (await errOf(runs.start(campaign(p.map((d) => d.id))))) !== 'none')
const done1 = await waitFor(() => runCompleted(run1.id), 20_000)
const it1 = items(run1.id)
check('30 publishing tasks: one per post and account', it1.length === 30 && new Set(it1.map((i) => `${i.sourceDraftId}|${i.accountId}`)).size === 30 && db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE kind = 'publish'")!.n === 30)
check('every eligible account received each of the 3 posts exactly once', done1 && eligible.every((a) => ['Post one', 'Post two', 'Post three'].every((t) => posted.filter((x) => x.accountId === a && x.text === t).length === 1)) && posted.length === 30, `${posted.length} posts`)
check('nothing went to the disabled account or the unavailable profile', !posted.some((x) => x.accountId === ACC(11) || x.accountId === ACC(12)))
check('each account-post result tracked on its own (30 published, each with its own link)', runs.details(run1.id).run.counts.published === 30 && new Set(it1.map((i) => i.postUrl)).size === 30 && it1.every((i) => i.scheduleStatus === 'completed'))
check('each account got its own copy of the post', new Set(it1.map((i) => i.draftId)).size === 30)

// ── 3. One account failing does not stop the others ──
const q = [await save('Failure test A'), await save('Failure test B')]
failing = ACC(3)
const before = posted.length
const run2 = await runs.start(campaign(q.map((d) => d.id)))
await waitFor(() => posted.length - before === 18 && items(run2.id).filter((i) => i.accountId === ACC(3)).some((i) => i.scheduleStatus === 'failed'), 20_000)
await sleep(300)
const it2 = items(run2.id)
const of3 = it2.filter((i) => i.accountId === ACC(3))
const tasks3 = db.all<{ id: string; status: string; held: number; error: string | null }>("SELECT t.id, t.status, t.held, t.error FROM tasks t JOIN run_items i ON i.schedule_id = t.schedule_id WHERE i.run_id = :r AND t.account_id = :a", { r: run2.id, a: ACC(3) })
check('one account signed out: one post fails with a clear reason, its other post is held (not failed again)', of3.length === 2 && tasks3.filter((t) => t.status === 'failed').length === 1 && tasks3.filter((t) => t.status === 'queued' && t.held === 1).length === 1, JSON.stringify(tasks3))
check('… the run is not paused: the other 9 accounts published both posts (18)', posted.length - before === 18 && it2.filter((i) => i.scheduleStatus === 'completed').length === 18 && runs.details(run2.id).run.status !== 'paused' && !queue.paused)
const failedTask = tasks3.find((t) => t.status === 'failed')!
check('… the failure says what to fix', (failedTask.error ?? '').includes('signed out'))

// ── 4. Safe retry: once per account, never a duplicate ──
failing = null
db.run('UPDATE tasks SET held = 0')
publishing.retryTask(failedTask.id)
await waitFor(() => db.get<{ status: string }>('SELECT status FROM tasks WHERE id = :id', { id: failedTask.id })?.status === 'succeeded')
const done2 = await waitFor(() => runCompleted(run2.id), 20_000)
const once = (text: string) => posted.filter((x) => x.accountId === ACC(3) && x.text === text).length === 1
check('after the sign-in is fixed: the retried post and the released one each publish once for that account', done2 && once('Failure test A') && once('Failure test B'), JSON.stringify(posted.filter((x) => x.accountId === ACC(3))))
check('… retrying it again is refused (it already succeeded), still once each', (await errOf(Promise.resolve().then(() => publishing.retryTask(failedTask.id)))) !== 'none' && once('Failure test A') && once('Failure test B'))
check('… the campaign then completes: 20 of 20 published', runs.details(run2.id).run.counts.published === 20)
const schedule = db.get<{ id: string; draft_id: string; account_id: string; run_at: string; status: string }>('SELECT * FROM scheduled_posts WHERE id = (SELECT schedule_id FROM tasks WHERE id = :id)', { id: failedTask.id })!
const again = publishing.enqueue({ id: schedule.id, draftId: schedule.draft_id, accountId: schedule.account_id, runAt: schedule.run_at, status: 'pending', remindedAt: null, createdAt: at, updatedAt: at })
check('… queueing the same schedule again returns the existing task (idempotency key)', again.id === failedTask.id && db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE schedule_id = :id', { id: schedule.id })!.n === 1)
check('the database refuses the same post twice for one account in a campaign', (() => {
  try {
    db.run("INSERT INTO run_items (id, run_id, position, kind, status, account_id, source_draft_id, created_at, updated_at) VALUES ('dup', :r, 999, 'post', 'pending', :a, :d, :at, :at)", { r: run1.id, a: ACC(1), d: p[0]!.id, at })
    return false
  } catch {
    return true
  }
})())

// ── 5. Scheduling: every task at the chosen time, nothing early ──
const s = [await save('Tomorrow one'), await save('Tomorrow two')]
const tomorrow = new Date()
tomorrow.setDate(tomorrow.getDate() + 1)
tomorrow.setHours(9, 0, 0, 0)
const before5 = posted.length
const run3 = await runs.start(campaign(s.map((d) => d.id), 'schedule', tomorrow.toISOString()))
await waitFor(() => items(run3.id).every((i) => i.status === 'scheduled'))
const it3 = items(run3.id)
check('scheduled campaign: 2 posts × 10 accounts = 20 schedules at the chosen time', it3.length === 20 && it3.every((i) => i.scheduleStatus === 'pending' && i.runAt === tomorrow.toISOString()) && new Set(it3.map((i) => i.accountId)).size === 10)
check('… nothing is published early', posted.length === before5)

// ── 6. Resumed after a restart: existing copies and schedules are reused, never duplicated ──
const draftsBefore = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM drafts')!.n
const schedulesBefore = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM scheduled_posts WHERE status <> 'cancelled'")!.n
// As if X Auto closed after the posts were prepared but before the run recorded it.
db.run("UPDATE run_items SET status = 'pending' WHERE run_id = :r", { r: run3.id })
db.run("UPDATE automation_runs SET status = 'paused' WHERE id = :r", { r: run3.id })
runs.resume(run3.id)
await waitFor(() => items(run3.id).every((i) => i.status === 'scheduled'))
check('resumed run: no new copies of the posts', db.get<{ n: number }>('SELECT COUNT(*) AS n FROM drafts')!.n === draftsBefore)
check('… and no second schedule for any account', db.get<{ n: number }>("SELECT COUNT(*) AS n FROM scheduled_posts WHERE status <> 'cancelled'")!.n === schedulesBefore && items(run3.id).every((i, _, all) => all.filter((x) => x.scheduleId === i.scheduleId).length === 1))
await runs.stop(run3.id)
check('stopping it cancels all 20 waiting posts', items(run3.id).every((i) => i.status === 'skipped'))

await queue.stop()
db.close()
console.log(results.join('\n'))
const failed = results.filter((r) => r.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
