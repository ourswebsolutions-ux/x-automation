// Automatic profile linking, publishing without account selection, comments posted as replies, and
// campaigns over every eligible synchronized profile. Real services and database throughout; IX
// Browser is the contract mock (tests/mocks/ixmock.mjs) and the engine is scripted (the real engine
// path is covered by engine/tests and the end-to-end suites).
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
import { AccountService } from '../../src/main/services/accounts/accountService'
import { RunService } from '../../src/main/services/automation/runService'
import { DraftService } from '../../src/main/services/drafts/draftService'
import { EngineError } from '../../src/main/services/engine/engineService'
import { IxBrowserService } from '../../src/main/services/integrations/ixbrowser/ixBrowserService'
import { EngagementService } from '../../src/main/services/links/engagementService'
import { Notifier } from '../../src/main/services/notifications/notifier'
import { PublishHandler } from '../../src/main/services/publishing/publishHandler'
import { PublishingService } from '../../src/main/services/publishing/publishingService'
import { QueueService } from '../../src/main/services/queue/queueService'
import { commentProblems } from '../../src/shared/lib/postComment'
import type { AutomationConfig } from '../../src/shared/types/automation'
// @ts-expect-error — plain JavaScript test helper
import { startMock } from '../mocks/ixmock.mjs'

const results: string[] = []
const check = (name: string, ok: boolean, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + String(extra).slice(0, 300) : ''}`)
const log = { debug() {}, info() {}, success() {}, warn() {}, error() {}, scope() { return log } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (fn: () => boolean, ms = 6000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await sleep(20)
  }
  return false
}
const errOf = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === 'function' ? p() : p)
    return 'none'
  } catch (e) {
    return `${(e as Error).name}: ${(e as Error).message}`
  }
}

const file = process.argv[2]!
for (const s of ['', '-wal', '-shm']) rmSync(file + s, { force: true })
const db = new SqliteDatabase(file).open()
check('migrate → v16', migrate(db, log as never) === 16)
check('v15 columns exist', ['comment_text', 'comment_enabled'].every((c) => db.all<{ name: string }>("PRAGMA table_info('drafts')").some((r) => r.name === c)) && db.all<{ name: string }>("PRAGMA table_info('browser_profiles')").some((r) => r.name === 'link_excluded_at'))

const mock = await startMock()
mock.state.profiles = mock.state.profiles.slice(0, 6) // Profile 001 … Profile 006
const endpoint = `http://127.0.0.1:${mock.port}`
db.run("INSERT INTO provider_configs (id, kind, name, endpoint, created_at, updated_at) VALUES ('prov', 'ixbrowser', 'IX', :endpoint, 'x', 'x')", { endpoint })
const config = { id: 'prov', kind: 'ixbrowser', name: 'IX', endpoint, enabled: true, readiness: { state: 'ready' }, settings: { timeoutMs: 3000, retries: 0 } }
const providers = { list: (kind: string) => (kind === 'ixbrowser' ? [config] : []), get: () => config }

const repos = createSqliteRepositories(db)
const profiles = new ProfileRepository(db)
const accounts = new AccountRepository(db)
const ix = new IxBrowserService({ providers: providers as never, profiles, settings: repos.settings, activity: repos.activity, log: log as never, onChange() {}, onProgress() {} })
const accountService = new AccountService({ accounts, profiles, ixBrowser: ix, log: log as never, onChange() {} })
const accountCount = () => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM accounts')!.n
const linkedCount = () => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM accounts WHERE browser_profile_id IS NOT NULL')!.n

// ── 1. Sync links every profile automatically ──
let run = await ix.sync()
check('sync: every profile found and linked automatically (no manual step)', run.status === 'succeeded' && run.discovered === 6 && run.linked === 6 && run.linkFailed === 0, JSON.stringify(run))
check('sync: one account record per profile, each linked to its own profile', accountCount() === 6 && linkedCount() === 6 && db.get<{ n: number }>('SELECT COUNT(DISTINCT browser_profile_id) AS n FROM accounts')!.n === 6)
const first = profiles.list()
const alpha = first.find((p) => p.externalId === 1)!
const alphaAccount = accounts.byProfile(alpha.id)!
check('auto-linked account: labelled with the profile name, username unknown, enabled', alphaAccount.label === 'Profile 001' && alphaAccount.handle === null && alphaAccount.identity === 'unknown' && alphaAccount.enabled)
check('sync history records the linking', ix.syncHistory(1)[0]?.linked === 6)

run = await ix.sync()
check('second sync: nothing linked twice, no duplicate accounts', run.linked === 0 && accountCount() === 6 && linkedCount() === 6)
check('second sync: profile ids (and links) preserved', profiles.list().every((p) => first.some((f) => f.id === p.id && f.externalId === p.externalId)) && accounts.byProfile(alpha.id)?.id === alphaAccount.id)
const [a, b] = await Promise.all([ix.sync(), ix.sync()])
check('two syncs at once: they join, still no duplicates', a.id === b.id && accountCount() === 6)

// ── 2. Disconnect, reconnect, removal ──
const beta = first.find((p) => p.externalId === 2)!
const betaAccount = accounts.byProfile(beta.id)!
accountService.unlink([betaAccount.id])
check('disconnect: profile marked as disconnected by you', profiles.get(beta.id)?.linkExcludedAt !== null && accounts.byProfile(beta.id) === null)
run = await ix.sync()
check('sync after disconnect: the profile is not linked again', run.linked === 0 && accounts.byProfile(beta.id) === null)
const reconnected = accountService.connectProfile(beta.id)
check('connect again: the same account is linked again, and syncs keep it', reconnected.id === betaAccount.id && profiles.get(beta.id)?.linkExcludedAt === null && accounts.byProfile(beta.id)?.id === betaAccount.id && accountCount() === 6)
const gamma = first.find((p) => p.externalId === 3)!
accountService.remove([accounts.byProfile(gamma.id)!.id])
run = await ix.sync()
check('removed account: its profile is not relinked by the next sync', run.linked === 0 && accounts.byProfile(gamma.id) === null && profiles.get(gamma.id)?.linkExcludedAt !== null)
check('connect after removal: a new account record is made', accountService.connectProfile(gamma.id).label === 'Profile 003' && accountCount() === 6)

// ── 3. Missing and returning profiles ──
const removed = mock.state.profiles.splice(3, 1) // Profile 004 disappears from IX Browser
run = await ix.sync()
const delta = first.find((p) => p.externalId === 4)!
check('missing profile: marked unavailable, account and link kept', run.unavailable === 1 && profiles.get(delta.id)?.availability === 'unavailable' && accounts.byProfile(delta.id) !== null)
mock.state.profiles.splice(3, 0, ...removed)
run = await ix.sync()
check('returning profile: available again with the same account (no duplicate)', profiles.get(delta.id)?.availability === 'available' && accountCount() === 6 && run.linked === 0, String(accountCount()))

// ── 4. A profile that can't be linked is reported and retried ──
mock.state.profiles.push({ ...mock.state.profiles[0], profile_id: 50, name: 'Fails once' })
db.exec("CREATE TRIGGER fail_link BEFORE INSERT ON accounts WHEN NEW.label = 'Fails once' BEGIN SELECT RAISE(ABORT, 'Simulated write failure'); END")
run = await ix.sync()
check('link failure: reported per profile, the others are unaffected', run.status === 'succeeded' && run.linkFailed === 1 && run.linkErrors[0]?.name === 'Fails once' && run.linkErrors[0]!.reason.length > 0 && run.linked === 0 && accountCount() === 6, JSON.stringify(run.linkErrors))
check('link failure: saved in the sync history (shown with Retry)', ix.syncHistory(1)[0]?.linkErrors[0]?.name === 'Fails once')
db.exec('DROP TRIGGER fail_link')
run = await ix.sync()
check('sync again: the failed profile is linked', run.linked === 1 && run.linkFailed === 0 && accounts.byProfile(profiles.getByExternalId(50)!.id) !== null)

mock.state.mode = 'http500'
const before = accountCount()
check('sync failure: reported, nothing linked or removed', (await errOf(ix.sync())) !== 'none' && accountCount() === before && ix.syncHistory(1)[0]?.status === 'failed')
mock.state.mode = 'ok'

// ── 5. Publishing from every eligible profile, with comments ──
const assetRepo = new AssetRepository(db)
const drafts = new DraftService(repos, db, assetRepo, log as never)
const queueRepo = new QueueRepository(db)
const prefs = { notifications: { taskFailures: { inApp: true, desktop: false }, scheduleReminders: { inApp: true, desktop: false }, systemNotices: { inApp: true, desktop: false } }, defaults: { textProviderId: null, imageProviderId: null } }
const notices: { title: string; body?: string }[] = []
const notifier = new Notifier({ preferences: { get: () => prefs } as never, log: log as never })
notifier.attach((n) => notices.push(n))
notifier.rendererListening()
const queue = new QueueService({ repo: queueRepo, settings: repos.settings, log: log as never, onChange() {}, backoffMs: () => 30 })
const postLinks = new PostLinkRepository(db)
const publishing = new PublishingService({ db, drafts: repos.drafts, accounts, schedules: new ScheduleRepository(db), postLinks, queue, queueRepo, duplicateDraft: (id) => drafts.duplicate(id), settings: repos.settings, activity: repos.activity, notifier, log: log as never, onChange() {} })
publishing.updateSettings({ spacingMinutes: 0, maxAttempts: 2 })

// Scripted engine: records every call; posts get ids, comments reply to them.
type Call = { endpoint: string; text: string; inReplyTo?: string; expectedHandle?: string }
const calls: Call[] = []
let nextId = 5000
const engineMode: { post: string; reply: string } = { post: 'ok', reply: 'ok' }
const engine = {
  killNow() {},
  async request(cmd: string, params: Record<string, unknown>) {
    if (cmd === 'x.findPost') return { found: false }
    const call = params as unknown as Call
    calls.push({ endpoint: call.endpoint, text: call.text, inReplyTo: call.inReplyTo, expectedHandle: call.expectedHandle })
    const mode = call.inReplyTo ? engineMode.reply : engineMode.post
    if (mode === 'signed-out') throw new EngineError('SESSION_EXPIRED', 'Signed out', false, false)
    if (mode === 'no-composer') throw new EngineError('COMPOSER_NOT_FOUND', 'No composer', true, false)
    if (mode === 'unconfirmed') throw new EngineError('OUTCOME_UNKNOWN', 'Not confirmed', false, true)
    const id = String(nextId++)
    return { ok: true, url: `https://x.com/acct/status/${id}`, postId: id, handle: 'acct', accountCheck: 'skipped' }
  }
}
const ixForPublish = { debuggingAddressFor: (externalId: number) => `127.0.0.1:${9000 + externalId}`, openProfile: async () => ({}), closeProfile: async () => ({}) }
const handlerDeps = {
  drafts: repos.drafts,
  accounts,
  postLinks,
  queueRepo,
  ixBrowser: ixForPublish as never,
  engine: engine as never,
  assetFile: () => null,
  settings: () => publishing.getSettings(),
  settle: (t: never, s: never) => publishing.settleTask(t, s),
  log: log as never,
  notifier
}
queue.register(new PublishHandler(handlerDeps))
queue.register(new PublishHandler(handlerDeps, 'reply'))
queue.start()

// Make one account disabled and one profile unavailable, so "eligible" is not "all".
const eps = profiles.list()
const disabledAccount = accounts.byProfile(eps.find((p) => p.externalId === 5)!.id)!
accountService.setEnabled([disabledAccount.id], false)
db.run("UPDATE browser_profiles SET availability = 'unavailable' WHERE external_id = '6'")
let targets = publishing.targets()
const eligibleIds = targets.eligible.map((t) => t.accountId)
check('targets: decided by the backend — enabled accounts on available profiles only', targets.eligible.length === 5 && !eligibleIds.includes(disabledAccount.id) && targets.unavailable.length === 2 && targets.profiles === 7, JSON.stringify({ e: targets.eligible.length, u: targets.unavailable }))

// A post without an account or a comment.
const plain = await drafts.save({ body: 'Release notes are up for 2.4', accountId: null })
check('a post is saved without choosing an account', plain.accountId === null && plain.comment.enabled === false)
let checkAll = await publishing.checkAll(plain.id)
check('check: all eligible accounts, unconfirmed usernames summarised as one warning', checkAll.ok && checkAll.targets.eligible.length === 5 && checkAll.problems.filter((p) => p.code === 'handle-unknown').length === 1)
check('publish to all needs the repeated-content permission', (await errOf(publishing.publishAll({ draftId: plain.id, runAt: null, allowSameText: false }))).includes('same text'))
let sent = await publishing.publishAll({ draftId: plain.id, runAt: null, allowSameText: true })
check('publish now: one post per eligible account (copies for the others)', sent.entries.length === 5 && sent.failed.length === 0 && new Set(sent.entries.map((e) => e.schedule.accountId)).size === 5 && sent.entries.every((e) => eligibleIds.includes(e.schedule.accountId)))
await waitFor(() => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE kind = 'publish' AND status = 'succeeded'")!.n === 5)
check('… all five confirmed and published', db.get<{ n: number }>("SELECT COUNT(*) AS n FROM scheduled_posts WHERE status = 'completed'")!.n === 5 && calls.length === 5)
check('… without a comment there are no reply tasks', db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE kind = 'reply'")!.n === 0 && calls.every((c) => !c.inReplyTo))
check('… each account posted from its own profile', new Set(calls.map((c) => c.endpoint)).size === 5)

// Comment validation.
check('comment on but empty: refused when saving', (await errOf(drafts.save({ body: 'x', accountId: null, comment: { enabled: true, text: '   ' } }))).includes('empty'))
check('comment over 280: a warning (X Premium), not a refusal', commentProblems({ enabled: true, text: 'y'.repeat(300) })[0]?.blocking === false && commentProblems({ enabled: true, text: 'y'.repeat(30_000) })[0]?.blocking === true)
const off = await drafts.save({ body: 'Comment off but kept', accountId: null, comment: { enabled: false, text: 'kept for later' } })
check('comment off: its text is kept, nothing will be posted', off.comment.enabled === false && off.comment.text === 'kept for later')

// A post with a comment.
calls.length = 0
const withComment = await drafts.save({ body: 'We just opened a new office in Lisbon', accountId: null, comment: { enabled: true, text: 'Details and openings: https://example.com/lisbon' } })
check('comment saved with the post', withComment.comment.enabled && withComment.comment.text.startsWith('Details'))
sent = await publishing.publishAll({ draftId: withComment.id, runAt: null, allowSameText: true })
const ok = await waitFor(() => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE kind = 'reply' AND status = 'succeeded'")!.n === 5, 8000)
const posts = calls.filter((c) => !c.inReplyTo)
const replies = calls.filter((c) => c.inReplyTo)
check('with a comment: every account posts, then replies to its own post', ok && posts.length === 5 && replies.length === 5, `${posts.length}/${replies.length}`)
const postIds = db.all<{ result: string; id: string; account_id: string }>("SELECT id, account_id, result FROM tasks WHERE kind = 'publish' AND draft_id IN (SELECT draft_id FROM scheduled_posts WHERE id IN (SELECT value FROM json_each(:ids)))", { ids: JSON.stringify(sent.entries.map((e) => e.schedule.id)) })
const replyRows = db.all<{ payload: string; account_id: string; idempotency_key: string; schedule_id: string | null }>("SELECT payload, account_id, idempotency_key, schedule_id FROM tasks WHERE kind = 'reply'")
check('… each comment answers that account’s own post (same account, parent post id)', postIds.every((p) => replyRows.some((r) => r.account_id === p.account_id && JSON.parse(r.payload).parentPostId === JSON.parse(p.result).postId)))
check('… the comment text is posted unchanged, after the post', replies.every((r) => r.text === 'Details and openings: https://example.com/lisbon') && calls.findIndex((c) => c.inReplyTo) > calls.findIndex((c) => !c.inReplyTo))
check('… one reply task per post (idempotency key), not tied to the schedule', replyRows.length === 5 && new Set(replyRows.map((r) => r.idempotency_key)).size === 5 && replyRows.every((r) => r.schedule_id === null))
check('… comments never become post links', db.get<{ n: number }>('SELECT COUNT(*) AS n FROM post_links')!.n === 10)
const again = queue.enqueue({ kind: 'reply', accountId: replyRows[0]!.account_id, draftId: null, scheduleId: null, label: 'x', payload: {}, idempotencyKey: replyRows[0]!.idempotency_key })
check('… the same comment can’t be queued twice', again.status === 'succeeded' && db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE kind = 'reply'")!.n === 5)

// Comment failures are reported honestly and never touch the post.
engineMode.reply = 'no-composer'
const failing = await drafts.save({ body: 'Comment will fail', accountId: null, comment: { enabled: true, text: 'A follow-up' } })
targets = publishing.targets()
const one = targets.eligible[0]!.accountId
await publishing.scheduleMany({ draftId: failing.id, accountIds: [one], runAt: null, allowSameText: false })
await waitFor(() => db.get<{ status: string }>("SELECT status FROM tasks WHERE kind = 'reply' AND draft_id = :id", { id: failing.id })?.status === 'failed', 6000)
const failedReply = db.get<{ status: string; error: string; attempts: number }>("SELECT status, error, attempts FROM tasks WHERE kind = 'reply' AND draft_id = :id", { id: failing.id })
check('comment failure: retried safely, then failed with a plain reason', failedReply?.status === 'failed' && failedReply.attempts === 2 && failedReply.error.includes('reply composer'), JSON.stringify(failedReply))
check('… the post itself stays published', db.get<{ status: string }>('SELECT status FROM drafts WHERE id = :id', { id: failing.id })?.status === 'published')
check('… and the failure is notified', notices.some((n) => n.title === 'A comment could not be posted'))
engineMode.reply = 'ok'
const failedReplyId = db.get<{ id: string }>("SELECT id FROM tasks WHERE kind = 'reply' AND draft_id = :id", { id: failing.id })!.id
publishing.retryTask(failedReplyId)
check('retrying a failed comment never touches its published post', db.get<{ status: string }>('SELECT status FROM drafts WHERE id = :id', { id: failing.id })?.status === 'published' && db.get<{ status: string }>('SELECT status FROM scheduled_posts WHERE draft_id = :id', { id: failing.id })?.status === 'completed')
check('… and the comment goes out on retry', await waitFor(() => db.get<{ status: string }>('SELECT status FROM tasks WHERE id = :id', { id: failedReplyId })?.status === 'succeeded'))

engineMode.reply = 'unconfirmed'
const unsure = await drafts.save({ body: 'Comment outcome unknown', accountId: null, comment: { enabled: true, text: 'Maybe posted' } })
await publishing.scheduleMany({ draftId: unsure.id, accountIds: [one], runAt: null, allowSameText: false })
await waitFor(() => db.get<{ status: string }>("SELECT status FROM tasks WHERE kind = 'reply' AND draft_id = :id", { id: unsure.id })?.status === 'needs-review', 6000)
const unsureTask = db.get<{ id: string; status: string; attempts: number }>("SELECT id, status, attempts FROM tasks WHERE kind = 'reply' AND draft_id = :id", { id: unsure.id })!
check('comment submitted but unconfirmed: needs review, never retried blindly', unsureTask.status === 'needs-review' && unsureTask.attempts === 1)
const linksBefore = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM post_links')!.n
publishing.resolveReview({ taskId: unsureTask.id, outcome: 'posted', url: 'https://x.com/acct/status/999999' })
check('… you confirm it: the comment is recorded, no post link or post status changes', db.get<{ status: string }>('SELECT status FROM tasks WHERE id = :id', { id: unsureTask.id })?.status === 'succeeded' && db.get<{ n: number }>('SELECT COUNT(*) AS n FROM post_links')!.n === linksBefore)
engineMode.reply = 'ok'

engineMode.post = 'signed-out'
const signedOut = await drafts.save({ body: 'Post fails', accountId: null, comment: { enabled: true, text: 'Never sent' } })
await publishing.scheduleMany({ draftId: signedOut.id, accountIds: [one], runAt: null, allowSameText: false })
await waitFor(() => db.get<{ status: string }>("SELECT status FROM tasks WHERE kind = 'publish' AND draft_id = :id", { id: signedOut.id })?.status === 'failed')
check('post failure: failed, and its comment is never queued', db.get<{ status: string }>("SELECT status FROM scheduled_posts WHERE draft_id = :id", { id: signedOut.id })?.status === 'failed' && db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE kind = 'reply' AND draft_id = :id", { id: signedOut.id })!.n === 0)
engineMode.post = 'ok'
// The signed-out failure holds that account's waiting posts; release them for the next checks.
db.run('UPDATE tasks SET held = 0')

// Scheduling for a future date and time.
const later = await drafts.save({ body: 'Tomorrow morning post', accountId: null, comment: { enabled: true, text: 'And a comment' } })
const tomorrow = new Date()
tomorrow.setDate(tomorrow.getDate() + 1)
tomorrow.setHours(9, 0, 0, 0)
sent = await publishing.publishAll({ draftId: later.id, runAt: tomorrow.toISOString(), allowSameText: true })
check('schedule: every eligible account gets a slot at the chosen time (stored in UTC)', sent.entries.length === 5 && sent.entries.every((e) => e.schedule.status === 'pending' && e.schedule.runAt === tomorrow.toISOString()))
check('… nothing is published or commented early', db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE draft_id IN (SELECT draft_id FROM scheduled_posts WHERE run_at = :at)", { at: tomorrow.toISOString() })!.n === 0)
check('schedule in the past is refused', (await publishing.checkAll(plain.id, new Date(Date.now() - 3_600_000).toISOString())).problems.some((p) => p.code === 'in-past'))

// No eligible profile.
db.run('UPDATE accounts SET enabled = 0')
checkAll = await publishing.checkAll(off.id)
check('no eligible profile: blocked, asking to sync', !checkAll.ok && checkAll.problems.some((p) => p.code === 'no-eligible' && p.message.includes('Sync')) && (await errOf(publishing.publishAll({ draftId: off.id, runAt: null, allowSameText: true }))).includes('Sync profiles first'))
db.run("UPDATE accounts SET enabled = 1 WHERE id <> :id", { id: disabledAccount.id })

// ── 6. Campaigns: every eligible profile, no selection ──
const engagement = new EngagementService({ repo: new EngagementRepository(db), links: postLinks, accounts, settings: repos.settings, ixBrowser: {} as never, engine: {} as never, log: log as never, onChange() {} })
const runs = new RunService({
  db,
  generator: { generate: async () => ({ status: 'failed', results: [], error: null }) } as never,
  images: {} as never,
  drafts,
  assets: assetRepo,
  accounts,
  accountService,
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
const campaign = (draftIds: string[], when: 'now' | 'schedule' = 'now', startAt: string | null = null, every = false): AutomationConfig => ({
  name: 'Launch week',
  mode: 'full-auto',
  content: { source: 'drafts', draftIds, prompt: '', topic: '', language: 'English', tone: 'professional', length: 'short', hashtags: [], suggestHashtags: false, instructions: '', generateText: false, textProviderId: null, textModel: null, fixedText: '', generateImages: false, imageProviderId: null, imageModel: null, imageStyle: 'illustration', imageSize: '1024x1024', existingAssetId: null },
  targets: { scope: 'all', profileIds: [], distribution: every ? 'same' : 'unique', allowDuplicates: every, requireConfirmedIdentity: false, createMissingAccounts: true },
  actions: { publish: true, saveDrafts: false, repost: false, comment: false, like: false, engagementLinks: [], commentText: '' },
  schedule: { when, startAt, endAt: null, intervalMinutes: 0, postsPerProfile: Math.max(draftIds.length, 1), maxPostsPerRun: 500, workingHours: { enabled: false, start: '09:00', end: '18:00' }, days: [0, 1, 2, 3, 4, 5, 6] },
  failure: { generationRetries: 0, onTextFailure: 'skip', onImageFailure: 'skip', onProfileUnavailable: 'skip', stopAfterFailures: 3 }
})
const c1 = await drafts.save({ body: 'Campaign post one', accountId: null, comment: { enabled: true, text: 'More on post one' } })
const c2 = await drafts.save({ body: 'Campaign post two', accountId: null })
let plan = runs.plan(campaign([c1.id, c2.id], 'now', null, true))
check('campaign plan: all eligible synchronized profiles, without selecting any', plan.ok && plan.profiles.eligible === 5 && plan.profiles.selected === 7 && plan.posts === 10, JSON.stringify(plan.profiles))
check('campaign plan: comments counted (one post has one, on 5 profiles)', plan.comments === 5 && plan.actions.some((a) => a.includes('reply')))
check('campaign plan: unconfirmed usernames are a warning, not a block', plan.problems.some((p) => !p.blocking && p.message.includes('without checking')))
calls.length = 0
let started = await runs.start(campaign([c1.id, c2.id], 'now', null, true))
check('campaign start: a second start with the same posts is refused (no duplicates)', (await errOf(runs.start(campaign([c1.id, c2.id], 'now', null, true)))) !== 'none')
await waitFor(() => runs.details(started.id).run.status === 'completed', 12000)
let details = runs.details(started.id)
check('campaign: posts went out on every eligible profile', details.run.counts.published === 10 && new Set(details.items.map((i) => i.accountId)).size === 5, JSON.stringify(details.run.counts))
check('campaign: completes only after every comment has an outcome', details.run.status === 'completed' && details.run.counts.comments.total === 5 && details.run.counts.comments.posted === 5)
const withC = details.items.filter((i) => i.comment)
check('campaign: each post with a comment shows the comment result and link', withC.length === 5 && withC.every((i) => i.comment!.status === 'succeeded' && i.comment!.url?.startsWith('https://x.com/')))
check('campaign: every operation records account, content, time and result', details.items.every((i) => i.accountId && i.text && i.runAt && i.scheduleStatus === 'completed' && i.postUrl))

const c3 = await drafts.save({ body: 'Next-day campaign post', accountId: null, comment: { enabled: true, text: 'Next-day comment' } })
const nextDay = new Date()
nextDay.setDate(nextDay.getDate() + 1)
nextDay.setHours(10, 30, 0, 0)
started = await runs.start(campaign([c3.id], 'schedule', nextDay.toISOString(), true))
await waitFor(() => runs.details(started.id).items.every((i) => i.status === 'scheduled'))
details = runs.details(started.id)
check('scheduled campaign: every eligible profile has the post at the chosen time', details.items.length === 5 && details.items.every((i) => i.status === 'scheduled' && i.scheduleStatus === 'pending' && i.runAt === nextDay.toISOString()))
check('scheduled campaign: running until the posts go out', details.run.status === 'publishing')
await runs.stop(started.id)
check('stopping it cancels the waiting posts', runs.details(started.id).items.every((i) => i.status === 'skipped'))

plan = runs.plan(campaign([c2.id]))
check('campaign with an already-published post is blocked', !plan.ok)
db.run('UPDATE accounts SET enabled = 0')
plan = runs.plan(campaign([(await drafts.save({ body: 'Nobody can post', accountId: null })).id]))
check('campaign with no eligible profile is blocked', !plan.ok && plan.problems.some((p) => p.blocking))

await queue.stop()
await mock.close()
db.close()
for (const line of results) console.log(line)
const failed = results.filter((r) => r.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
