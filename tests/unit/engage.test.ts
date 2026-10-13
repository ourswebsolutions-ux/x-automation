// Campaign reposts and comments, done by X Auto at the chosen time and counted only when X confirms
// them; exact timing for scheduled posts. Real services (runs, publishing, queue, the publish/reply/
// repost handler, the post scheduler) and database; the engine is scripted — the real engine against
// a real browser is covered by engine/tests, and nothing here touches x.com.
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
import { EngineError } from '../../src/main/services/engine/engineService'
import { EngagementService } from '../../src/main/services/links/engagementService'
import { Notifier } from '../../src/main/services/notifications/notifier'
import { PublishHandler } from '../../src/main/services/publishing/publishHandler'
import { PublishingService } from '../../src/main/services/publishing/publishingService'
import { Scheduler } from '../../src/main/services/publishing/scheduler'
import { QueueService } from '../../src/main/services/queue/queueService'
import { defaultChoices, toConfig } from '../../src/shared/lib/campaign'

const results: string[] = []
const check = (name: string, ok: boolean, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + String(extra).slice(0, 300) : ''}`)
const log = { debug() {}, info() {}, success() {}, warn() {}, error() {} }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (fn: () => boolean, ms = 8_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await sleep(15)
  }
  return false
}

const file = process.argv[2]!
for (const s of ['', '-wal', '-shm']) rmSync(file + s, { force: true })
const db = new SqliteDatabase(file).open()
check('migrate → v15 (repost tasks)', migrate(db, log as never) === 15)
check('the tasks table accepts repost tasks (rebuilt CHECK)', (() => {
  try {
    db.run("INSERT INTO tasks (id, kind, status, label, run_after, created_at, updated_at) VALUES ('probe', 'repost', 'cancelled', 'x', 'x', 'x', 'x')")
    db.run("DELETE FROM tasks WHERE id = 'probe'")
    return true
  } catch {
    return false
  }
})())

const at = new Date().toISOString()
const ACC = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
for (let n = 1; n <= 3; n++) {
  db.run("INSERT INTO browser_profiles (id, external_id, name, synced_at, first_seen_at, availability, run_state) VALUES (:id, :ext, :name, :at, :at, 'available', 'closed')", { id: `p${n}`, ext: String(200 + n), name: `Profile ${n}`, at })
  db.run("INSERT INTO accounts (id, label, handle, identity, identity_confirmed_at, browser_profile_id, linked_at, enabled, created_at, updated_at) VALUES (:id, :label, :handle, 'confirmed', :at, :pid, :at, 1, :at, :at)", { id: ACC(n), label: `Account ${n}`, handle: `acct_${n}`, pid: `p${n}`, at })
}

const repos = createSqliteRepositories(db)
const assets = new AssetRepository(db)
const drafts = new DraftService(repos, db, assets, log as never)
const accounts = new AccountRepository(db)
const queueRepo = new QueueRepository(db)
const schedules = new ScheduleRepository(db)
const prefs = { notifications: { taskFailures: { inApp: true, desktop: false }, scheduleReminders: { inApp: true, desktop: false }, systemNotices: { inApp: true, desktop: false } }, defaults: { textProviderId: null, imageProviderId: null } }
const notices: { title: string; body?: string }[] = []
const notifier = new Notifier({ preferences: { get: () => prefs } as never, log: log as never })
notifier.attach((n) => notices.push(n))
notifier.rendererListening()
const postLinks = new PostLinkRepository(db)

// Scripted engine: records every command with when it ran.
type Call = { cmd: string; at: number; params: Record<string, unknown> }
const calls: Call[] = []
const script: Record<string, (p: Record<string, unknown>) => Record<string, unknown>> = {}
let nextId = 7000
const engine = {
  killNow() {},
  async request(cmd: string, params: Record<string, unknown>, opts?: { onProgress?: (s: string) => void }) {
    calls.push({ cmd, at: Date.now(), params })
    if (cmd === 'x.findPost') return { found: false }
    const custom = script[cmd]
    if (custom) return custom(params)
    for (const s of ['attach', 'open-post', 'submit', 'confirm']) opts?.onProgress?.(s)
    if (cmd === 'x.repost') return { url: params.url, postId: String(params.url).split('/').pop(), handle: 'acct', alreadyReposted: false }
    const id = String(nextId++)
    return { url: `https://x.com/acct/status/${id}`, postId: id, handle: 'acct', accountCheck: 'match', verifiedBy: 'post-link' }
  }
}
const ix = { debuggingAddressFor: (e: number) => `127.0.0.1:${9000 + e}`, openProfile: async () => ({}), closeProfile: async () => ({}) }

let queue!: QueueService
let publishing!: PublishingService
let runs!: RunService
const engagement = new EngagementService({ repo: new EngagementRepository(db), links: postLinks, accounts, settings: repos.settings, ixBrowser: {} as never, engine: {} as never, log: log as never, onChange() {} })
/** The services as the app wires them; called again to simulate an app restart on the same database. */
function boot(): void {
  queue = new QueueService({ repo: queueRepo, settings: repos.settings, log: log as never, onChange() {}, backoffMs: () => 30 })
  publishing = new PublishingService({ db, drafts: repos.drafts, accounts, schedules, postLinks, queue, queueRepo, duplicateDraft: (id) => drafts.duplicate(id), settings: repos.settings, activity: repos.activity, notifier, log: log as never, onChange() {} })
  publishing.updateSettings({ spacingMinutes: 0, maxAttempts: 2 })
  const deps = { drafts: repos.drafts, accounts, postLinks, queueRepo, ixBrowser: ix as never, engine: engine as never, assetFile: () => null, settings: () => publishing.getSettings(), settle: (t: never, s: never) => publishing.settleTask(t, s), log: log as never, notifier }
  for (const kind of ['publish', 'reply', 'repost'] as const) queue.register(new PublishHandler(deps, kind))
  runs = new RunService({
    db, generator: {} as never, images: {} as never, drafts, assets, accounts,
    accountService: { createFromProfiles: () => ({ changed: 0, skipped: [], accounts: [] }) } as never,
    profiles: new ProfileRepository(db), providers: { list: () => [] } as never, preferences: { get: () => prefs } as never,
    publishing, engagement, queue, notifier, log: log as never, onChange() {}
  })
  queue.start()
}
boot()

const repostCampaign = (links: string[], when: 'now' | 'schedule' = 'now', startAt: string | null = null) => toConfig({ ...defaultChoices(), name: 'Reposts', action: 'repost', repostLinks: links, when, startAt })
const commentCampaign = (link: string, text: string, when: 'now' | 'schedule' = 'now', startAt: string | null = null) => toConfig({ ...defaultChoices(), name: 'Comment', action: 'comment', repostLinks: [link], commentText: text, when, startAt })
const run = (id: string) => runs.details(id).run
const items = (id: string) => runs.details(id).items.filter((i) => i.kind === 'engagement')
const engTask = (id: string) => db.get<{ status: string }>('SELECT status FROM engagement_tasks WHERE id = (SELECT engagement_task_id FROM run_items WHERE run_id = :id)', { id })?.status
const settled = (id: string) => ['completed', 'failed', 'stopped'].includes(run(id).status)

// ── 1. Immediate repost: performed and confirmed, then Completed ──
const r1 = await runs.start(repostCampaign(['https://x.com/author_a/status/1900000000000000101']))
check('repost now: shown as Scheduled/Running until X confirms (never Completed at start)', run(r1.id).status === 'publishing' && items(r1.id)[0]?.status === 'scheduled')
await waitFor(() => settled(r1.id))
const c1 = calls.filter((c) => c.cmd === 'x.repost')
check('repost now: X Auto reposted that exact post from one account, with the account check', c1.length === 1 && c1[0]!.params.url === 'https://x.com/author_a/status/1900000000000000101' && /^acct_\d$/.test(String(c1[0]!.params.expectedHandle)))
check('… Completed only after the confirmation; the item says Reposted', run(r1.id).status === 'completed' && items(r1.id)[0]?.taskStatus === 'succeeded' && run(r1.id).counts.published === 1)
check('… its Post Links task is marked done, and the user is told', engTask(r1.id) === 'done' && notices.some((n) => n.title === 'Reposted'))
const t1 = db.get<{ result: string }>("SELECT result FROM tasks WHERE kind = 'repost'")!
check('… recorded as verified from the post’s state on X (not the click)', JSON.parse(t1.result).verifiedBy === 'post-state')

// ── 2. Scheduled repost: not before its time, then automatically ──
const dueSoon = new Date(Date.now() + 1500).toISOString()
const callsBefore = calls.length
const r2 = await runs.start(repostCampaign(['https://x.com/author_b/status/1900000000000000102'], 'schedule', dueSoon))
await sleep(700)
check('scheduled repost: nothing happens before the chosen time', calls.length === callsBefore && items(r2.id)[0]?.taskStatus === 'queued' && run(r2.id).status === 'publishing')
await waitFor(() => settled(r2.id))
const c2 = calls.slice(callsBefore).find((c) => c.cmd === 'x.repost')
check('… it runs automatically at the chosen time (not before)', Boolean(c2) && c2!.at >= new Date(dueSoon).getTime() && c2!.at - new Date(dueSoon).getTime() < 1500, c2 ? `${c2.at - new Date(dueSoon).getTime()} ms after` : 'not run')
check('… and the campaign completes with it', run(r2.id).status === 'completed')

// ── 3. Failures are never shown as completed ──
script['x.repost'] = () => {
  throw new EngineError('NOT_SENT', 'X did not repost it: after a reload the post still shows Repost, not Undo repost. Nothing was reposted.', false, true)
}
const r3 = await runs.start(repostCampaign(['https://x.com/author_c/status/1900000000000000103']))
await waitFor(() => settled(r3.id))
check('repost X did not take: the item is Failed with X Auto’s reason', items(r3.id)[0]?.taskStatus === 'failed' && (items(r3.id)[0]?.error ?? '').includes('Nothing was reposted'), items(r3.id)[0]?.error ?? '')
check('… and a campaign where nothing succeeded ends as Failed, not Completed', run(r3.id).status === 'failed' && notices.some((n) => n.title === 'Campaign failed'), run(r3.id).status)
check('… its Post Links task stays open', engTask(r3.id) === 'open')
script['x.repost'] = () => {
  throw new EngineError('OUTCOME_UNKNOWN', 'The repost was clicked, but X’s page did not show whether it went through.', false, true)
}
const r4 = await runs.start(repostCampaign(['https://x.com/author_d/status/1900000000000000104']))
await waitFor(() => settled(r4.id))
const t4 = db.get<{ id: string; status: string; attempts: number }>("SELECT id, status, attempts FROM tasks WHERE idempotency_key = 'engage:' || (SELECT engagement_task_id FROM run_items WHERE run_id = :id)", { id: r4.id })!
check('unconfirmed repost: needs review, never retried blindly, never Completed', t4.status === 'needs-review' && t4.attempts === 1 && run(r4.id).status === 'failed' && run(r4.id).counts.needsReview === 1)
check('… "posted" in review needs the link (no claim without evidence)', (() => {
  try {
    publishing.resolveReview({ taskId: t4.id, outcome: 'posted', url: null })
    return false
  } catch {
    return true
  }
})())
delete script['x.repost']

// ── 4. Safe retries: never a second repost ──
const failed3 = db.get<{ id: string }>("SELECT id FROM tasks WHERE idempotency_key = 'engage:' || (SELECT engagement_task_id FROM run_items WHERE run_id = :id)", { id: r3.id })!
const before4 = calls.filter((c) => c.cmd === 'x.repost').length
publishing.retryTask(failed3.id)
await waitFor(() => db.get<{ status: string }>('SELECT status FROM tasks WHERE id = :id', { id: failed3.id })?.status === 'succeeded')
check('retrying a failed repost runs it once more', calls.filter((c) => c.cmd === 'x.repost').length === before4 + 1)
check('… a second retry of the succeeded task is refused', (() => {
  try {
    publishing.retryTask(failed3.id)
    return false
  } catch {
    return true
  }
})())
check('… the same campaign repost can’t be queued twice (idempotency key)', db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE idempotency_key LIKE 'engage:%' GROUP BY idempotency_key HAVING n > 1") === undefined)
const again = runs.plan(repostCampaign(['https://x.com/author_a/status/1900000000000000101']))
check('… reposting the same post again from your accounts is refused, with the reason in the preview (one of your accounts per post)', !again.ok && again.engagementTasks === 0 && (again.engagementPreview[0]?.skipped ?? '').startsWith('Skipped:'), JSON.stringify(again.engagementPreview))
script['x.repost'] = (p) => ({ url: p.url, postId: '1', handle: 'acct', alreadyReposted: true })
const r5 = await runs.start(repostCampaign(['https://x.com/author_e/status/1900000000000000105']))
await waitFor(() => settled(r5.id))
check('a post already reposted on X (e.g. by hand) counts as done, without reposting it again', run(r5.id).status === 'completed' && items(r5.id)[0]?.taskStatus === 'succeeded')
delete script['x.repost']

// ── 5. Comments on a chosen post: now and at the chosen time ──
const k1 = await runs.start(commentCampaign('https://x.com/author_f/status/1900000000000000106', 'Thanks — the benchmark section was really useful.'))
await waitFor(() => settled(k1.id))
const kc = calls.filter((c) => c.cmd === 'x.publish' && c.params.inReplyTo === '1900000000000000106')
check('comment now: posted as a reply to that post, with your text, from one account', kc.length === 1 && kc[0]!.params.text === 'Thanks — the benchmark section was really useful.')
check('… Completed only after X confirmed it; the item says Comment posted', run(k1.id).status === 'completed' && items(k1.id)[0]?.taskStatus === 'succeeded' && engTask(k1.id) === 'done')
const kDue = new Date(Date.now() + 1500).toISOString()
const k2 = await runs.start(commentCampaign('https://x.com/author_g/status/1900000000000000107', 'Scheduled reply text', 'schedule', kDue))
await sleep(700)
check('scheduled comment: nothing is posted before the chosen time', !calls.some((c) => c.params.inReplyTo === '1900000000000000107'))
await waitFor(() => settled(k2.id))
const k2c = calls.find((c) => c.params.inReplyTo === '1900000000000000107')
check('… posted automatically at the chosen time', Boolean(k2c) && k2c!.at >= new Date(kDue).getTime() && run(k2.id).status === 'completed')
script['x.publish'] = () => {
  throw new EngineError('REJECTED', 'X did not accept the post (X said: Replies are limited).', false, true)
}
const k3 = await runs.start(commentCampaign('https://x.com/author_h/status/1900000000000000108', 'This one is refused'))
await waitFor(() => settled(k3.id))
check('comment X refuses: Failed with X’s own words, campaign Failed', items(k3.id)[0]?.taskStatus === 'failed' && (items(k3.id)[0]?.error ?? '').includes('Replies are limited') && run(k3.id).status === 'failed', items(k3.id)[0]?.error ?? '')
delete script['x.publish']

// ── 6. Restarts: scheduled reposts survive; a missed time is not done late ──
const dueAfterRestart = new Date(Date.now() + 1200).toISOString()
const r6 = await runs.start(repostCampaign(['https://x.com/author_i/status/1900000000000000109'], 'schedule', dueAfterRestart))
await queue.stop()
boot() // X Auto restarted: new services, same database
await waitFor(() => settled(r6.id))
check('after a restart, the scheduled repost still runs at its time', run(r6.id).status === 'completed' && calls.some((c) => c.cmd === 'x.repost' && c.params.url === 'https://x.com/author_i/status/1900000000000000109' && c.at >= new Date(dueAfterRestart).getTime()))
// A repost whose time passed long ago while X Auto was closed.
const longAgo = new Date(Date.now() - 2 * 3_600_000).toISOString()
db.run("UPDATE automation_runs SET status = 'stopped' WHERE status = 'publishing'")
await queue.stop()
const r7 = await (async () => {
  // Planned while the app ran, then "closed" until long after its time.
  const startedRun = await runs.start(repostCampaign(['https://x.com/author_j/status/1900000000000000110'], 'schedule', new Date(Date.now() + 3_600_000).toISOString()))
  db.run("UPDATE tasks SET run_after = :t, payload = json_set(payload, '$.dueAt', :t) WHERE idempotency_key = 'engage:' || (SELECT engagement_task_id FROM run_items WHERE run_id = :id)", { t: longAgo, id: startedRun.id })
  return startedRun
})()
const before7 = calls.length
boot()
await waitFor(() => settled(r7.id))
check('a time missed while X Auto was closed is not done hours late: Failed "missed", nothing clicked', items(r7.id)[0]?.taskStatus === 'failed' && (items(r7.id)[0]?.error ?? '').includes('passed while X Auto was not running') && !calls.slice(before7).some((c) => c.cmd === 'x.repost'), items(r7.id)[0]?.error ?? '')
const missed = db.get<{ id: string }>("SELECT id FROM tasks WHERE idempotency_key = 'engage:' || (SELECT engagement_task_id FROM run_items WHERE run_id = :id)", { id: r7.id })!
publishing.retryTask(missed.id)
check('… retrying it does it now', await waitFor(() => db.get<{ status: string }>('SELECT status FROM tasks WHERE id = :id', { id: missed.id })?.status === 'succeeded'))
// A repost running when X Auto closed: never done again automatically.
db.run("INSERT INTO tasks (id, kind, status, account_id, label, payload, idempotency_key, attempts, max_attempts, run_after, started_at, created_at, updated_at) VALUES ('interrupted', 'repost', 'running', :a, 'Repost', :p, 'engage:interrupted', 1, 2, :t, :t, :t, :t)", { a: ACC(1), p: JSON.stringify({ engagementTaskId: 'x', url: 'https://x.com/author_k/status/1900000000000000111', dueAt: null }), t: at })
await queue.stop()
boot()
await sleep(300)
check('a repost interrupted by a shutdown needs review — it is never repeated on its own', db.get<{ status: string }>("SELECT status FROM tasks WHERE id = 'interrupted'")?.status === 'needs-review' && !calls.some((c) => c.params.url === 'https://x.com/author_k/status/1900000000000000111'))

// ── 6b. "Select all" posts: each post gets one account, accounts take turns, Start = the preview ──
db.run("UPDATE automation_runs SET status = 'stopped' WHERE status = 'publishing'")
const many = ['https://x.com/news_one/status/1900000000000000201', 'https://x.com/news_two/status/1900000000000000202', 'https://x.com/news_three/status/1900000000000000203', 'https://x.com/news_four/status/1900000000000000204']
const at6b = new Date(Date.now() + 3_600_000).toISOString()
const plan6b = runs.plan(repostCampaign(many, 'schedule', at6b))
const assigned6b = plan6b.engagementPreview.filter((p) => !p.skipped)
check('select all (4 posts, 3 accounts): every post assigned to exactly one account, accounts take turns', plan6b.ok && assigned6b.length === 4 && new Set(assigned6b.map((p) => p.url)).size === 4 && new Set(assigned6b.slice(0, 3).map((p) => p.accountId)).size === 3 && assigned6b[3]!.accountId === assigned6b[0]!.accountId, JSON.stringify(plan6b.engagementPreview.map((p) => [p.url.slice(-3), p.accountLabel, p.skipped])))
check('… the preview shows each post’s account label and its scheduled time', assigned6b.every((p) => p.accountLabel?.startsWith('Account ') && p.runAt === at6b))
const run6b = await runs.start(repostCampaign(many, 'schedule', at6b))
const queued6b = db.all<{ account_id: string; payload: string; run_after: string }>("SELECT t.account_id, t.payload, t.run_after FROM tasks t JOIN run_items i ON t.idempotency_key = 'engage:' || i.engagement_task_id WHERE i.run_id = :id", { id: run6b.id })
check('… Start creates exactly the previewed assignment: one repost task per post, same accounts, at the chosen time', queued6b.length === 4 && assigned6b.every((p) => queued6b.some((q) => JSON.parse(q.payload).url === p.url && q.account_id === p.accountId && q.run_after === at6b)), JSON.stringify(queued6b.map((q) => [JSON.parse(q.payload).url.slice(-3), q.account_id.slice(-2)])))
check('… never several of your accounts on the same post', db.get<{ n: number }>("SELECT COUNT(*) AS n FROM (SELECT link_id FROM engagement_tasks WHERE kind = 'repost' GROUP BY link_id HAVING COUNT(DISTINCT account_id) > 1)")!.n === 0)
await runs.stop(run6b.id)

// Your own post: only its own account may repost it; a post another account already reposted is skipped.
const own = 'https://x.com/acct_2/status/1900000000000000301'
const taken = 'https://x.com/news_one/status/1900000000000000201' // planned above (now cancelled → its task is still open)
db.run("UPDATE engagement_tasks SET status = 'done' WHERE link_id = (SELECT id FROM post_links WHERE post_id = '1900000000000000201')")
const plan6c = runs.plan(repostCampaign([own, taken, 'https://x.com/news_five/status/1900000000000000205']))
const pOwn = plan6c.engagementPreview.find((p) => p.url === own)
const pTaken = plan6c.engagementPreview.find((p) => p.url === taken)
check('your own post (by @acct_2) is assigned only to that account, never amplified by your others', pOwn?.accountId === ACC(2) && !pOwn.skipped, JSON.stringify(pOwn))
check('a post one of your accounts already reposted is skipped, with the reason shown', Boolean(pTaken?.skipped) && /already/.test(pTaken!.skipped!), JSON.stringify(pTaken))
check('… the rest still go ahead (2 of 3 assigned)', plan6c.ok && plan6c.engagementTasks === 2)

// A comment on several selected posts: on one post only; the others skipped with the reason.
const plan6d = runs.plan(commentCampaign('https://x.com/news_six/status/1900000000000000206', 'One thoughtful comment'))
const multiComment = toConfig({ ...defaultChoices(), name: 'Comment many', action: 'comment', repostLinks: ['https://x.com/news_six/status/1900000000000000206', 'https://x.com/news_seven/status/1900000000000000207', 'https://x.com/news_eight/status/1900000000000000208'], commentText: 'One thoughtful comment', when: 'now', startAt: null })
const plan6e = runs.plan(multiComment)
check('comment with "select all" (3 posts): one comment, 2 skipped with the reason', plan6d.ok && plan6e.ok && plan6e.engagementTasks === 1 && plan6e.engagementPreview.filter((p) => (p.skipped ?? '').includes('one post only')).length === 2)
const callsBefore6e = calls.length
const run6e = await runs.start(multiComment)
await waitFor(() => settled(run6e.id))
check('… Start posts the comment once, on the first post only', calls.slice(callsBefore6e).filter((c) => c.cmd === 'x.publish' && c.params.inReplyTo).length === 1 && calls.slice(callsBefore6e).find((c) => c.params.inReplyTo)?.params.inReplyTo === '1900000000000000206' && run(run6e.id).status === 'completed')

// One account failing does not stop the other accounts' reposts.
const failingAccount = ACC(1)
script['x.repost'] = (p) => {
  if (calls.at(-1) && calls.filter((c) => c.cmd === 'x.repost').length && String(p.expectedHandle) === 'acct_1') throw new EngineError('SESSION_EXPIRED', 'Signed out', false, false)
  return { url: p.url, postId: String(p.url).split('/').pop(), handle: 'acct', alreadyReposted: false }
}
const three = ['https://x.com/news_nine/status/1900000000000000209', 'https://x.com/news_ten/status/1900000000000000210', 'https://x.com/news_eleven/status/1900000000000000211']
const run6f = await runs.start(repostCampaign(three))
await waitFor(() => settled(run6f.id), 10_000)
const it6f = items(run6f.id)
check('one account signed out: its repost fails, the other accounts’ reposts still go through', it6f.length === 3 && it6f.filter((i) => i.taskStatus === 'succeeded').length === 2 && it6f.filter((i) => i.taskStatus === 'failed' && i.accountId === failingAccount).length === 1, JSON.stringify(it6f.map((i) => [i.accountId?.slice(-2), i.taskStatus])))
check('… and the campaign reports the partial failure (Completed, 2 published, 1 failed)', run(run6f.id).status === 'completed' && run(run6f.id).counts.published === 2 && run(run6f.id).counts.failed === 1)
delete script['x.repost']
db.run('UPDATE tasks SET held = 0')

// ── 7. Scheduled posts go out at their time (not up to a scheduler tick later), never before ──
const scheduler = new Scheduler({ db, schedules, accounts, publishing, settings: () => publishing.getSettings(), notifier, log: log as never, onChange() {}, tickMs: 15_000 })
const post = await drafts.save({ body: 'Exact-time post', accountId: null })
const postDue = new Date(Date.now() + 1200).toISOString()
await publishing.schedule({ draftId: post.id, accountId: ACC(1), runAt: postDue })
scheduler.start()
await sleep(600)
check('scheduled post: not handed to the queue before its time', db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE draft_id = :id', { id: post.id })!.n === 0)
await waitFor(() => calls.some((c) => c.cmd === 'x.publish' && String(c.params.text).startsWith('Exact-time post')), 6000)
const pc = calls.find((c) => c.cmd === 'x.publish' && String(c.params.text).startsWith('Exact-time post'))
check('… published right at its time (within a second), not up to 15 s later', Boolean(pc) && pc!.at >= new Date(postDue).getTime() && pc!.at - new Date(postDue).getTime() < 1000, pc ? `${pc.at - new Date(postDue).getTime()} ms after` : 'not published')
scheduler.stop()

await queue.stop()
db.close()
console.log(results.join('\n'))
const failedChecks = results.filter((r) => r.startsWith('FAIL')).length
console.log(`\n${results.length - failedChecks}/${results.length} passed`)
process.exit(failedChecks ? 1 : 0)
