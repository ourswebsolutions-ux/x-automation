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
const campaign = (draftIds: string[], when: 'now' | 'schedule' = 'now', startAt: string | null = null, seed?: number) => toConfig({ ...defaultChoices(), name: 'Launch', action: 'post', draftIds, when, startAt, ...(seed === undefined ? {} : { seed }) })
const save = (body: string) => drafts.save({ body, accountId: null })
const saveMany = async (n: number, tag: string) => {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push((await save(`${tag} ${i + 1}`)).id)
  return out
}
const items = (runId: string) => runs.details(runId).items.filter((i) => i.kind === 'post')
const runCompleted = (runId: string) => runs.details(runId).run.status === 'completed'
const stopAll = () => db.run("UPDATE automation_runs SET status = 'stopped' WHERE status IN ('generating', 'awaiting-approval', 'paused', 'publishing')")
const accountsOf = (plan: ReturnType<typeof runs.plan>) => plan.postPreview.map((p) => p.accountId)

// ── 1. The config the form sends: one random account per post ──
const cfg = campaign(['x'])
check('the Campaigns form sends one account per post, in a random order (no account picker)', cfg.targets.scope === 'all' && cfg.targets.distribution === 'unique' && !cfg.targets.allowDuplicates && typeof cfg.targets.shuffleSeed === 'number' && cfg.targets.profileIds.length === 0)
check('… and one failing account never pauses the others (no stop-after-failures)', cfg.failure.stopAfterFailures === 0)

// ── 2. Task counts and assignments ──
const ten = await saveMany(10, 'Ten posts')
const plan10 = runs.plan(campaign(ten, 'now', null, 101))
check('10 posts, 10 eligible accounts → 10 tasks (not 100), each account once', plan10.ok && plan10.posts === 10 && plan10.postPreview.length === 10 && new Set(accountsOf(plan10)).size === 10, JSON.stringify({ posts: plan10.posts, accounts: new Set(accountsOf(plan10)).size }))
check('… every post exactly once', new Set(plan10.postPreview.map((p) => p.draftId)).size === 10)
check('… never the disabled account or the unavailable profile', !accountsOf(plan10).some((a) => a === ACC(11) || a === ACC(12)))
const five = await saveMany(5, 'Five posts')
const plan5 = runs.plan(campaign(five, 'now', null, 202))
check('5 posts, 10 eligible accounts → 5 tasks (not 50) on 5 different accounts', plan5.ok && plan5.posts === 5 && new Set(accountsOf(plan5)).size === 5, JSON.stringify(accountsOf(plan5)))
const again5 = runs.plan(campaign(five, 'now', null, 202))
check('… the same campaign (same seed) previews the same assignment every time', JSON.stringify(accountsOf(again5)) === JSON.stringify(accountsOf(plan5)))
const draws = new Set([1, 2, 3, 4, 5, 6].map((seed) => accountsOf(runs.plan(campaign(five, 'now', null, seed))).slice().sort().join()))
check('… new campaigns draw different accounts (not always the first five)', draws.size > 1 && [...draws].some((d) => d !== eligible.slice(0, 5).slice().sort().join()), [...draws].join(' | '))
const twelve = await saveMany(12, 'Twelve posts')
const plan12 = runs.plan(campaign(twelve, 'now', null, 303))
const per12 = new Map<string, number>()
for (const a of accountsOf(plan12)) per12.set(a!, (per12.get(a!) ?? 0) + 1)
check('12 posts, 10 accounts → 12 tasks; every account gets one before any gets a second', plan12.posts === 12 && per12.size === 10 && Math.max(...per12.values()) === 2 && [...per12.values()].filter((n) => n === 2).length === 2, JSON.stringify([...per12.values()]))

// ── 3. Start executes exactly the preview ──
const p = [await save('Post one'), await save('Post two'), await save('Post three')]
const seed = 4242
const plan = runs.plan(campaign(p.map((d) => d.id), 'now', null, seed))
check('plan: 3 posts → 3 tasks on 3 different accounts, the unavailable profile and disabled account left out', plan.ok && plan.posts === 3 && new Set(accountsOf(plan)).size === 3 && plan.targets.filter((t) => !t.eligible).length === 2)
const run1 = await runs.start(campaign(p.map((d) => d.id), 'now', null, seed))
check('a second start with the same posts is refused (no duplicate campaign)', (await errOf(runs.start(campaign(p.map((d) => d.id))))) !== 'none')
const done1 = await waitFor(() => runCompleted(run1.id), 20_000)
const it1 = items(run1.id)
check('Start created exactly the previewed assignment (same post → same account)', it1.length === 3 && plan.postPreview.every((pp) => it1.some((i) => i.sourceDraftId === pp.draftId && i.accountId === pp.accountId)), JSON.stringify(it1.map((i) => [i.sourceDraftId?.slice(0, 4), i.accountId?.slice(-2)])))
check('each post published once, by its one account', done1 && ['Post one', 'Post two', 'Post three'].every((t) => posted.filter((x) => x.text === t).length === 1) && it1.every((i) => posted.some((x) => x.text === i.text && x.accountId === i.accountId)))
check('each result tracked on its own (3 published, each with its own link)', runs.details(run1.id).run.counts.published === 3 && new Set(it1.map((i) => i.postUrl)).size === 3)
check('the database refuses the same post twice for one account in a campaign', (() => {
  try {
    db.run("INSERT INTO run_items (id, run_id, position, kind, status, account_id, source_draft_id, created_at, updated_at) VALUES ('dup', :r, 999, 'post', 'pending', :a, :d, :at, :at)", { r: run1.id, a: it1[0]!.accountId, d: it1[0]!.sourceDraftId, at })
    return false
  } catch {
    return true
  }
})())

// ── 4. One account failing does not stop the others; safe retry ──
stopAll()
const q = await saveMany(4, 'Failure test')
const planQ = runs.plan(campaign(q, 'now', null, 77))
failing = planQ.postPreview[0]!.accountId
const before = posted.length
const run2 = await runs.start(campaign(q, 'now', null, 77))
await waitFor(() => posted.length - before === 3 && items(run2.id).some((i) => i.scheduleStatus === 'failed'), 20_000)
await waitFor(() => runs.details(run2.id).run.status !== 'publishing', 5_000)
const it2 = items(run2.id)
check('one account signed out: only its post fails, with a clear reason; the 3 others are published', it2.filter((i) => i.scheduleStatus === 'failed').length === 1 && it2.find((i) => i.scheduleStatus === 'failed')?.accountId === failing && it2.filter((i) => i.scheduleStatus === 'completed').length === 3 && posted.length - before === 3)
check('… the campaign reports the partial failure (Completed: 3 published, 1 failed), not paused', runs.details(run2.id).run.status === 'completed' && runs.details(run2.id).run.counts.failed === 1 && !queue.paused, runs.details(run2.id).run.status)
const failedTask = db.get<{ id: string; error: string }>("SELECT t.id, t.error FROM tasks t JOIN run_items i ON i.schedule_id = t.schedule_id WHERE i.run_id = :r AND t.status = 'failed'", { r: run2.id })!
check('… the failure says what to fix', failedTask.error.includes('signed out'))
failing = null
db.run('UPDATE tasks SET held = 0')
publishing.retryTask(failedTask.id)
await waitFor(() => db.get<{ status: string }>('SELECT status FROM tasks WHERE id = :id', { id: failedTask.id })?.status === 'succeeded')
const failedText = it2.find((i) => i.scheduleStatus === 'failed')!.text
check('retrying the failed post publishes it once, from its same account', posted.filter((x) => x.text === failedText).length === 1 && posted.find((x) => x.text === failedText)?.accountId === planQ.postPreview[0]!.accountId)
check('… retrying it again is refused (it already succeeded), still once', (await errOf(Promise.resolve().then(() => publishing.retryTask(failedTask.id)))) !== 'none' && posted.filter((x) => x.text === failedText).length === 1)
const schedule = db.get<{ id: string; draft_id: string; account_id: string; run_at: string }>('SELECT * FROM scheduled_posts WHERE id = (SELECT schedule_id FROM tasks WHERE id = :id)', { id: failedTask.id })!
const dupTask = publishing.enqueue({ id: schedule.id, draftId: schedule.draft_id, accountId: schedule.account_id, runAt: schedule.run_at, status: 'pending', remindedAt: null, createdAt: at, updatedAt: at })
check('… queueing the same schedule again returns the existing task (idempotency key)', dupTask.id === failedTask.id && db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE schedule_id = :id', { id: schedule.id })!.n === 1)

// ── 5. Scheduling: every task at the chosen time, nothing early ──
stopAll()
const sIds = await saveMany(4, 'Tomorrow')
const tomorrow = new Date()
tomorrow.setDate(tomorrow.getDate() + 1)
tomorrow.setHours(9, 0, 0, 0)
const before5 = posted.length
const planS = runs.plan(campaign(sIds, 'schedule', tomorrow.toISOString(), 55))
check('scheduled campaign preview: each post with its account and the chosen time', planS.postPreview.length === 4 && planS.postPreview.every((pp) => pp.runAt === tomorrow.toISOString() && pp.accountLabel?.startsWith('Account ')))
const run3 = await runs.start(campaign(sIds, 'schedule', tomorrow.toISOString(), 55))
await waitFor(() => items(run3.id).length === 4 && items(run3.id).every((i) => i.status === 'scheduled'))
const it3 = items(run3.id)
check('scheduled campaign: 4 schedules (one per post) at the chosen time, on the previewed accounts', it3.length === 4 && it3.every((i) => i.scheduleStatus === 'pending' && i.runAt === tomorrow.toISOString()) && planS.postPreview.every((pp) => it3.some((i) => i.sourceDraftId === pp.draftId && i.accountId === pp.accountId)))
check('… nothing is published early', posted.length === before5)

// ── 6. Resumed after a restart: the saved assignment is reused, never re-drawn or duplicated ──
const assignmentBefore = JSON.stringify(it3.map((i) => [i.sourceDraftId, i.accountId]).sort())
const draftsBefore = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM drafts')!.n
const schedulesBefore = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM scheduled_posts WHERE status <> 'cancelled'")!.n
db.run("UPDATE run_items SET status = 'pending' WHERE run_id = :r", { r: run3.id })
db.run("UPDATE automation_runs SET status = 'paused' WHERE id = :r", { r: run3.id })
runs.resume(run3.id)
await waitFor(() => items(run3.id).every((i) => i.status === 'scheduled'))
check('resumed run: same posts on the same accounts', JSON.stringify(items(run3.id).map((i) => [i.sourceDraftId, i.accountId]).sort()) === assignmentBefore)
check('… no new copies and no second schedule', db.get<{ n: number }>('SELECT COUNT(*) AS n FROM drafts')!.n === draftsBefore && db.get<{ n: number }>("SELECT COUNT(*) AS n FROM scheduled_posts WHERE status <> 'cancelled'")!.n === schedulesBefore)
await runs.stop(run3.id)
check('stopping it cancels all 4 waiting posts', items(run3.id).every((i) => i.status === 'skipped'))

// ── 7. Create Post → Publish… is unchanged: one post from every eligible account ──
const solo = await save('Create Post publish to all')
const sent = await publishing.publishAll({ draftId: solo.id, runAt: null, allowSameText: true })
check('Create Post → Publish… still sends the post to all 10 eligible accounts', sent.entries.length === 10 && new Set(sent.entries.map((e) => e.schedule.accountId)).size === 10)

await queue.stop()
db.close()
console.log(results.join('\n'))
const failed = results.filter((r) => r.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
