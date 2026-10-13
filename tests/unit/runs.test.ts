// Phase 12 unit tests: automation runs (plan, Full Auto, Manual Approval, failure policies, stop, recovery).
// AI providers are scripted fakes; drafts, publishing, queue and database are the real services.
import { randomUUID } from 'node:crypto'
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
import { DraftService } from '../../src/main/services/drafts/draftService'
import { EngagementService } from '../../src/main/services/links/engagementService'
import { Notifier } from '../../src/main/services/notifications/notifier'
import { PublishingService } from '../../src/main/services/publishing/publishingService'
import { QueueService } from '../../src/main/services/queue/queueService'
import { RunService, slotTime } from '../../src/main/services/automation/runService'
import { TaskError } from '../../src/main/services/queue/types'
import type { AutomationConfig } from '../../src/shared/types/automation'

const results: string[] = []
const check = (name: string, ok: boolean, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + String(extra).slice(0, 300) : ''}`)
const log = { debug() {}, info() {}, success() {}, warn() {}, error() {} }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (fn: () => boolean, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(20) } return false }
const errOf = async (p: Promise<unknown> | (() => unknown)) => { try { await (typeof p === 'function' ? p() : p); return 'none' } catch (e) { return (e as Error).message } }

const file = process.argv[2]!
rmSync(file, { force: true })
const db = new SqliteDatabase(file).open()
check('migrate → v14', migrate(db, log as never) === 14)
const at = new Date().toISOString()
db.exec(`INSERT INTO browser_profiles (id, external_id, name, synced_at, first_seen_at, availability, run_state) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001','1','Alpha','${at}','${at}','available','closed'),('aaaaaaaa-0000-4000-8000-000000000002','2','Beta','${at}','${at}','available','closed'),('aaaaaaaa-0000-4000-8000-000000000003','3','Gamma','${at}','${at}','unavailable','closed'),('aaaaaaaa-0000-4000-8000-000000000004','4','Delta','${at}','${at}','available','closed')`)
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const D = '44444444-4444-4444-8444-444444444444'
db.exec(`INSERT INTO accounts (id, label, handle, identity, identity_confirmed_at, browser_profile_id, linked_at, enabled, created_at, updated_at) VALUES
  ('${A}','Alpha brand','alpha_x','confirmed','${at}','aaaaaaaa-0000-4000-8000-000000000001','${at}',1,'${at}','${at}'),
  ('${B}','Beta brand','beta_x','confirmed','${at}','aaaaaaaa-0000-4000-8000-000000000002','${at}',1,'${at}','${at}'),
  ('${D}','Delta brand',NULL,'unknown',NULL,'aaaaaaaa-0000-4000-8000-000000000004','${at}',1,'${at}','${at}')`)

const repos = createSqliteRepositories(db)
const assetRepo = new AssetRepository(db)
const drafts = new DraftService(repos, db, assetRepo, log as never)
const accounts = new AccountRepository(db)
const profiles = new ProfileRepository(db)
const queueRepo = new QueueRepository(db)
const notices: { title: string; body?: string }[] = []
const prefs = { notifications: { taskFailures: { inApp: true, desktop: false }, scheduleReminders: { inApp: true, desktop: false }, systemNotices: { inApp: true, desktop: false } }, defaults: { textProviderId: 'pt', imageProviderId: 'pi' } }
const notifier = new Notifier({ preferences: { get: () => prefs } as never, log: log as never })
notifier.attach((n) => notices.push(n))
notifier.rendererListening()
const queue = new QueueService({ repo: queueRepo, settings: repos.settings, log: log as never, onChange() {}, backoffMs: () => 50 })
const publishing = new PublishingService({ db, drafts: repos.drafts, accounts, schedules: new ScheduleRepository(db), postLinks: new PostLinkRepository(db), queue, queueRepo, settings: repos.settings, activity: repos.activity, notifier, log: log as never, onChange() {} })
publishing.updateSettings({ spacingMinutes: 0 })
// A publish handler that "posts" instantly (the engine path is covered by the e2e suites).
const published: string[] = []
let publishMode: 'ok' | 'signed-out' = 'ok'
queue.register({
  kind: 'publish', idempotent: false,
  async run(task) {
    if (publishMode === 'signed-out') throw new TaskError('SESSION_EXPIRED', 'This profile is signed out of X.', 'fail')
    published.push(task.id)
    return { url: `https://x.com/x/status/${1000 + published.length}`, postId: String(1000 + published.length), handle: 'x', verifiedBy: 'post-link' }
  },
  settle: (t, s) => publishing.settleTask(t, s)
} as never)
queue.start()
const engagement = new EngagementService({ repo: new EngagementRepository(db), links: new PostLinkRepository(db), accounts, settings: repos.settings, ixBrowser: {} as never, engine: {} as never, log: log as never, onChange() {} })

let genCalls = 0
let genMode: 'ok' | 'fail' | 'auth' | 'dupes' | 'long' = 'ok'
const generator = {
  async generate(brief: { variations: number }) {
    genCalls++
    if (genMode === 'fail') return { status: 'failed', results: [], error: { kind: 'server', message: 'x', hint: '' } }
    if (genMode === 'auth') return { status: 'failed', results: [], error: { kind: 'auth', message: 'The key was rejected.', hint: '' } }
    if (genMode === 'long') return { status: 'succeeded', results: ['y'.repeat(400)], error: null }
    if (genMode === 'dupes') return { status: 'succeeded', results: Array.from({ length: brief.variations }, () => 'Always the same post'), error: null }
    return { status: 'succeeded', results: Array.from({ length: brief.variations }, (_, i) => `Generated post ${genCalls}.${i + 1} about shipping software`), error: null }
  }
}
let imgMode: 'ok' | 'fail' = 'ok'
let imgCalls = 0
const images = {
  async suggestPrompt() { return { ok: true, prompt: 'A clean illustration of a laptop', providerName: 'x', model: 'm' } },
  async generate() {
    imgCalls++
    if (imgMode === 'fail') return { status: 'failed', assets: [], error: { kind: 'server', message: 'Image failed', hint: '' } }
    const id = randomUUID()
    assetRepo.insert({ id, origin: 'generated', originalName: 'gen.png', filePath: `2026-10/${id}.png`, mimeType: 'image/png', width: 1024, height: 1024, sizeBytes: 2048, sha256: id.replace(/-/g, ''), animated: false, prompt: 'p', generationId: null, kept: false, createdAt: new Date().toISOString() })
    return { status: 'succeeded', assets: [{ id, available: true }], error: null }
  }
}
const providers = { list: (kind: string) => [{ id: kind === 'image' ? 'pi' : 'pt', kind, enabled: true, readiness: { state: 'ready' } }] }
const createdFromProfiles: string[] = []
const runs = new RunService({
  db, generator: generator as never, images: images as never, drafts, assets: assetRepo, accounts,
  accountService: { createFromProfiles: (ids: string[]) => { createdFromProfiles.push(...ids); for (const pid of ids) db.run("INSERT INTO accounts (id, label, identity, browser_profile_id, linked_at, enabled, created_at, updated_at) VALUES (:id, 'Auto', 'unknown', :pid, :at, 1, :at, :at)", { id: randomUUID(), pid, at }); return { changed: ids.length, skipped: [], accounts: [] } } } as never,
  profiles, providers: providers as never, preferences: { get: () => prefs } as never, publishing, engagement, queue, notifier, log: log as never, onChange() {}
})

const base = (): AutomationConfig => ({
  name: 'Tech posts',
  mode: 'full-auto',
  content: { source: 'generate', draftIds: [], prompt: 'Professional technology posts in English', topic: '', language: 'English', tone: 'professional', length: 'short', hashtags: ['tech'], suggestHashtags: false, instructions: '', generateText: true, textProviderId: null, textModel: null, fixedText: '', generateImages: true, imageProviderId: null, imageModel: null, imageStyle: 'illustration', imageSize: '1024x1024', existingAssetId: null },
  targets: { scope: 'all', profileIds: [], distribution: 'unique', allowDuplicates: false, requireConfirmedIdentity: true, createMissingAccounts: false },
  actions: { publish: true, saveDrafts: false, repost: false, comment: false, like: false, engagementLinks: [], commentText: '' },
  schedule: { when: 'now', startAt: null, endAt: null, intervalMinutes: 0, postsPerProfile: 2, maxPostsPerRun: 50, workingHours: { enabled: false, start: '09:00', end: '18:00' }, days: [0, 1, 2, 3, 4, 5, 6] },
  failure: { generationRetries: 1, onTextFailure: 'skip', onImageFailure: 'pause', onProfileUnavailable: 'skip', stopAfterFailures: 0 }
})
const itemsOf = (id: string) => runs.details(id).items

// ── plan ──
let plan = runs.plan(base())
check('plan: All Profiles counts selected / available / unavailable / eligible', plan.profiles.selected === 4 && plan.profiles.available === 3 && plan.profiles.unavailable === 1 && plan.profiles.eligible === 2 && plan.profiles.unconfirmed === 1, JSON.stringify(plan.profiles))
check('plan: posts = eligible profiles × posts per profile, one image each', plan.ok && plan.posts === 4 && plan.generations === 4 && plan.images === 4)
check('plan: warnings for unavailable and unconfirmed profiles', plan.problems.some((p) => p.message.includes('unavailable')) && plan.problems.some((p) => p.message.includes('confirmed')))
plan = runs.plan({ ...base(), targets: { ...base().targets, scope: 'selected', profileIds: [] } })
check('plan: Selected Profiles with nothing selected is blocked (never expands to all)', !plan.ok && plan.problems.some((p) => p.message.includes('Select at least one')))
plan = runs.plan({ ...base(), targets: { ...base().targets, scope: 'selected', profileIds: ['aaaaaaaa-0000-4000-8000-000000000002'] } })
check('plan: Selected Profiles uses only those', plan.posts === 2 && plan.targets.length === 1 && plan.targets[0]!.profileName === 'Beta')
plan = runs.plan({ ...base(), targets: { ...base().targets, distribution: 'same' } })
check('plan: same text on several profiles needs explicit permission', !plan.ok && plan.problems.some((p) => p.message.includes('same text')))
plan = runs.plan({ ...base(), targets: { ...base().targets, distribution: 'same', allowDuplicates: true } })
check('… allowed: generate once per slot, warn about repeats', plan.ok && plan.generations === 2 && plan.posts === 4 && plan.problems.some((p) => p.message.includes('repeated content')))
plan = runs.plan({ ...base(), failure: { ...base().failure, onProfileUnavailable: 'stop' } })
check('plan: unavailable profile + "stop" policy blocks the start', !plan.ok)
plan = runs.plan({ ...base(), targets: { ...base().targets, requireConfirmedIdentity: false, createMissingAccounts: true } })
check('plan: unconfirmed identities allowed explicitly → included, with a warning', plan.profiles.eligible === 3 && plan.problems.some((p) => p.message.includes('without checking')))
plan = runs.plan({ ...base(), schedule: { ...base().schedule, maxPostsPerRun: 3 } })
check('plan: max posts per run caps the run', plan.posts === 3 && plan.problems.some((p) => p.message.includes('Limited to 3')))
plan = runs.plan({ ...base(), actions: { ...base().actions, like: true, engagementLinks: ['https://example.com/x'] } })
check('plan: engagement links validated', !plan.ok && plan.problems.some((p) => p.message.includes('not a link to a post')))
const wh: AutomationConfig = { ...base(), schedule: { ...base().schedule, intervalMinutes: 60, workingHours: { enabled: true, start: '09:00', end: '12:00' } } }
const day = new Date(2026, 9, 12, 11, 30)
const s1 = slotTime(wh, day, 1)
check('working hours: a slot outside the window moves to the next window start', s1.getDate() === 13 && s1.getHours() === 9 && s1.getMinutes() === 0, s1.toString())
check('working hours: a slot inside stays', slotTime(wh, day, 0).getHours() === 11)
// Posting days (campaign schedule): day = Monday 2026-10-12, 11:30
const weekdays: AutomationConfig = { ...base(), schedule: { ...base().schedule, intervalMinutes: 60, days: [2, 4], workingHours: { enabled: true, start: '10:00', end: '12:00' } } }
const d0 = slotTime(weekdays, day, 0)
check('posting days: Monday start moves to Tuesday at the posting hours start', d0.getDay() === 2 && d0.getHours() === 10 && d0.getMinutes() === 0, d0.toString())
const d2 = slotTime(weekdays, day, 3)
check('posting days: later slots skip to the next posting day (Thursday)', d2.getDay() === 4 && d2.getHours() >= 10 && d2.getHours() < 12, d2.toString())
const anyTime: AutomationConfig = { ...base(), schedule: { ...base().schedule, intervalMinutes: 0, days: [0, 6], workingHours: { enabled: false, start: '09:00', end: '18:00' } } }
check('posting days without hours: next Saturday at midnight', slotTime(anyTime, day, 0).getDay() === 6 && slotTime(anyTime, day, 0).getHours() === 0)
check('every day selected: time unchanged', slotTime({ ...base(), schedule: { ...base().schedule, days: [0, 1, 2, 3, 4, 5, 6] } }, day, 0).getTime() === day.getTime())
check('no posting day chosen → blocked', runs.plan({ ...base(), schedule: { ...base().schedule, days: [] } }).problems.some((p) => p.blocking && p.message.includes('posting day')))

// ── Full Auto: generate, attach, schedule, publish — no per-post confirmation ──
const run1 = await runs.start(base())
check('Full Auto run started', run1.status === 'generating' && notices.some((n) => n.title === 'Automation started'))
check('… all posts published without any approval step', await waitFor(() => runs.details(run1.id).run.status === 'completed', 6000), JSON.stringify(runs.details(run1.id).run.counts))
let items = itemsOf(run1.id)
check('… 4 posts, each with its own text and an attached image', items.length === 4 && new Set(items.map((i) => i.text)).size === 4 && items.every((i) => i.image === 'attached' && i.imageAssetId))
check('… images really attached to the drafts (and kept in the library)', items.every((i) => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM draft_attachments a JOIN image_assets s ON s.id = a.asset_id WHERE a.draft_id = :d AND s.kept = 1', { d: i.draftId })?.n === 1))
check('… only eligible profiles (confirmed identity) got posts', items.every((i) => i.accountId === A || i.accountId === B) && items.filter((i) => i.accountId === A).length === 2)
check('… published with post links recorded', published.length === 4 && items.every((i) => i.scheduleStatus === 'completed' && i.postUrl))
check('… finished notice', notices.some((n) => n.title === 'Automation finished' && n.body === '4 published'))
check('… drafts carry the hashtag preference', db.get<{ hashtags: string }>('SELECT hashtags FROM drafts WHERE id = :id', { id: items[0]!.draftId })?.hashtags === '["tech"]')

// ── Manual Approval: generate + attach, then wait ──
const before = published.length
const run2 = await runs.start({ ...base(), name: 'Approve me', mode: 'manual-approval', targets: { ...base().targets, scope: 'selected', profileIds: ['aaaaaaaa-0000-4000-8000-000000000001'] } })
check('Manual Approval: posts generated and wait for approval', await waitFor(() => runs.details(run2.id).run.status === 'awaiting-approval'))
await sleep(200)
items = itemsOf(run2.id)
check('… nothing published before approval', published.length === before && items.every((i) => i.status === 'awaiting-approval' && i.image === 'attached'))
check('… a second run can’t start while approvals are pending', (await errOf(runs.start(base()))).includes('still active'))
const regen = await runs.regenerate(run2.id, items[0]!.id)
check('regenerate: new text for the same draft, still waiting', regen.text !== items[0]!.text && regen.draftId === items[0]!.draftId && regen.status === 'awaiting-approval')
check('remove: item dropped, draft kept', runs.remove(run2.id, [items[1]!.id]) === 1 && db.get<{ n: number }>('SELECT COUNT(*) AS n FROM drafts WHERE id = :id', { id: items[1]!.draftId })?.n === 1)
const appr = await runs.approve(run2.id, [items[0]!.id])
check('approve: published and run completes', appr.approved === 1 && (await waitFor(() => runs.details(run2.id).run.status === 'completed')) && published.length === before + 1)

// switching mode keeps everything; to Full Auto approves what's waiting
const run3 = await runs.start({ ...base(), name: 'Switch', mode: 'manual-approval', targets: { ...base().targets, scope: 'selected', profileIds: ['aaaaaaaa-0000-4000-8000-000000000002'] } })
await waitFor(() => runs.details(run3.id).run.status === 'awaiting-approval')
const draftsBefore = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM drafts')!.n
await runs.setMode(run3.id, 'full-auto')
check('switch to Full Auto: waiting posts published, no draft lost', (await waitFor(() => runs.details(run3.id).run.status === 'completed')) && db.get<{ n: number }>('SELECT COUNT(*) AS n FROM drafts')!.n === draftsBefore)

// ── failure policies ──
imgMode = 'fail'
const run4 = await runs.start({ ...base(), name: 'Image fails → pause', targets: { ...base().targets, scope: 'selected', profileIds: ['aaaaaaaa-0000-4000-8000-000000000001'] } })
check('image failure + "pause" policy → run paused, nothing published without its image', (await waitFor(() => runs.details(run4.id).run.status === 'paused')) && itemsOf(run4.id).every((i) => i.status === 'pending' || i.image === 'failed') && notices.some((n) => n.title === 'Automation paused'))
check('… retried within the limit (1 retry = 2 attempts)', imgCalls >= 2)
await runs.stop(run4.id)
const run5 = await runs.start({ ...base(), name: 'Image fails → without', failure: { ...base().failure, onImageFailure: 'without-image' }, targets: { ...base().targets, scope: 'selected', profileIds: ['aaaaaaaa-0000-4000-8000-000000000001'] } })
check('image failure + explicit "without image" → published text-only, marked so', (await waitFor(() => runs.details(run5.id).run.status === 'completed')) && itemsOf(run5.id).every((i) => i.image === 'skipped' && !i.imageAssetId && i.scheduleStatus === 'completed'))
const run6 = await runs.start({ ...base(), name: 'Image fails → skip', failure: { ...base().failure, onImageFailure: 'skip' }, targets: { ...base().targets, scope: 'selected', profileIds: ['aaaaaaaa-0000-4000-8000-000000000001'] } })
check('image failure + "skip" → posts skipped, never claimed attached', (await waitFor(() => runs.details(run6.id).run.status === 'completed')) && itemsOf(run6.id).every((i) => i.status === 'failed' && i.image === 'failed'))
imgMode = 'ok'
genMode = 'auth'
const run7 = await runs.start({ ...base(), name: 'Text fails → pause', failure: { ...base().failure, onTextFailure: 'pause' }, targets: { ...base().targets, scope: 'selected', profileIds: ['aaaaaaaa-0000-4000-8000-000000000001'] } })
check('AI provider rejected → run paused + “AI provider connection failed. Check settings.”', (await waitFor(() => runs.details(run7.id).run.status === 'paused')) && notices.some((n) => n.title === 'AI provider connection failed. Check settings.'))
genMode = 'ok'
await runs.resume(run7.id)
check('resume after fixing the provider → completes', await waitFor(() => runs.details(run7.id).run.status === 'completed', 6000))
genMode = 'dupes'
const run8 = await runs.start({ ...base(), name: 'Duplicates', failure: { ...base().failure, generationRetries: 2, onTextFailure: 'skip' }, targets: { ...base().targets, scope: 'selected', profileIds: ['aaaaaaaa-0000-4000-8000-000000000001'] } })
await waitFor(() => runs.details(run8.id).run.status === 'completed', 6000)
check('duplicate AI output is never posted twice', new Set(itemsOf(run8.id).filter((i) => i.text).map((i) => i.text)).size === itemsOf(run8.id).filter((i) => i.text).length && itemsOf(run8.id).some((i) => i.status === 'failed'))
genMode = 'long'
const run9 = await runs.start({ ...base(), name: 'Too long', targets: { ...base().targets, scope: 'selected', profileIds: ['aaaaaaaa-0000-4000-8000-000000000001'] } })
await waitFor(() => runs.details(run9.id).run.status === 'completed', 6000)
check('posts over the X length limit are rejected, not published', itemsOf(run9.id).every((i) => i.status === 'failed' && !i.draftId))
genMode = 'ok'

// signed-out profile: its other waiting posts are held, the user is told once
publishMode = 'signed-out'
const run10 = await runs.start({ ...base(), name: 'Signed out', schedule: { ...base().schedule, postsPerProfile: 3 }, targets: { ...base().targets, scope: 'selected', profileIds: ['aaaaaaaa-0000-4000-8000-000000000001'] } })
await waitFor(() => itemsOf(run10.id).some((i) => i.scheduleStatus === 'failed'), 6000)
await sleep(300)
check('signed-out profile → its other waiting posts are put on hold', db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE account_id = :a AND status = 'queued' AND held = 1", { a: A })!.n >= 1 && notices.some((n) => n.title.includes('signed out of X')))
publishMode = 'ok'
await runs.stop(run10.id)

// stop: waiting posts are cancelled and return to drafts
await queue.stop()
const run11 = await runs.start({ ...base(), name: 'Stop me', schedule: { ...base().schedule, when: 'schedule', startAt: new Date(Date.now() + 3_600_000).toISOString(), intervalMinutes: 30 }, targets: { ...base().targets, scope: 'selected', profileIds: ['aaaaaaaa-0000-4000-8000-000000000002'] } })
await waitFor(() => runs.details(run11.id).run.status === 'publishing')
check('scheduled run: posts scheduled for later', itemsOf(run11.id).every((i) => i.scheduleStatus === 'pending') && new Date(itemsOf(run11.id)[1]!.runAt!).getTime() - new Date(itemsOf(run11.id)[0]!.runAt!).getTime() === 30 * 60_000)
const stopped = await runs.stop(run11.id)
check('stop: waiting posts cancelled and returned to drafts', stopped.status === 'stopped' && itemsOf(run11.id).every((i) => i.status === 'skipped') && itemsOf(run11.id).every((i) => db.get<{ status: string }>('SELECT status FROM drafts WHERE id = :id', { id: i.draftId })?.status === 'ready'))

// engagement actions are planned as manual tasks, one account per post
const run12 = await runs.start({ ...base(), name: 'Engage', actions: { publish: false, saveDrafts: false, repost: true, comment: true, like: true, engagementLinks: ['https://x.com/someone/status/77'], commentText: 'Great insight!' } })
const eng = itemsOf(run12.id).filter((i) => i.kind === 'engagement')
check('engagement: repost/comment/like planned as tasks for the user (not performed)', eng.length === 3 && db.get<{ n: number }>("SELECT COUNT(*) AS n FROM engagement_tasks WHERE status = 'open'")!.n === 3)
check('… one of your accounts per action (no coordinated engagement)', db.get<{ n: number }>("SELECT COUNT(DISTINCT kind) AS n FROM engagement_tasks")!.n === 3 && db.get<{ n: number }>("SELECT COUNT(*) AS n FROM engagement_tasks WHERE kind IN ('like','repost')")!.n === 2)

// recovery: a run interrupted while generating is paused, not regenerated
db.run("UPDATE automation_runs SET status = 'generating' WHERE id = :id", { id: run12.id })
db.run("INSERT INTO automation_runs (id, name, mode, status, config, created_at, updated_at) VALUES ('rr', 'Interrupted', 'full-auto', 'generating', :c, :at, :at)", { c: JSON.stringify(base()), at })
db.run("INSERT INTO run_items (id, run_id, position, kind, status, created_at, updated_at) VALUES ('ri', 'rr', 0, 'post', 'generating', :at, :at)", { at })
const calls = genCalls
runs.recover()
check('restart: interrupted run paused (no surprise generation)', runs.details('rr').run.status === 'paused' && itemsOf('rr')[0]!.status === 'pending' && genCalls === calls)

// presets
const preset = runs.savePreset({ name: 'Weekly tech', config: base() })
check('preset saved and listed', runs.listPresets().some((p) => p.id === preset.id && p.config.content.prompt.includes('technology')))
check('preset names are unique', (await errOf(() => runs.savePreset({ name: 'weekly TECH', config: base() }))).includes('already exists'))
check('preset config validated', (await errOf(() => runs.savePreset({ name: 'Bad', config: { ...base(), schedule: { ...base().schedule, postsPerProfile: 0 } } }))) !== 'none')

// ── content sources: your own drafts, or drafts + AI ──
db.run("UPDATE automation_runs SET status = 'stopped' WHERE status IN ('generating', 'awaiting-approval', 'paused', 'publishing')")
publishMode = 'ok'
imgMode = 'ok'
genMode = 'ok'
queue.start() // stopped by the stop test above
const mk = (body: string) => drafts.save({ body, hashtags: [], accountId: null, status: 'draft' })
const own = [await mk('My handwritten post one'), await mk('My handwritten post two'), await mk('My handwritten post three')]
const fromDraftsCfg = (patch: Partial<AutomationConfig['content']> = {}): AutomationConfig => ({ ...base(), content: { ...base().content, source: 'drafts', draftIds: own.map((d) => d.id), generateImages: false, ...patch } })
plan = runs.plan(fromDraftsCfg())
check('drafts: plan posts your drafts, generates nothing', plan.ok && plan.fromDrafts === 3 && plan.generations === 0 && plan.posts === 3 && plan.images === 0, JSON.stringify({ ...plan, targets: undefined, problems: plan.problems.map((p) => p.message) }))
check('… warns when there are fewer drafts than slots', plan.problems.some((p) => p.message.includes('Only 3 drafts')))
{
  const imgId = randomUUID()
  assetRepo.insert({ id: imgId, origin: 'upload', originalName: 'p.png', filePath: `2026-10/${imgId}.png`, mimeType: 'image/png', width: 10, height: 10, sizeBytes: 100, sha256: imgId.replace(/-/g, ''), animated: false, prompt: null, generationId: null, kept: true, createdAt: new Date().toISOString() })
  const withImage = await drafts.save({ body: 'A post that already has a picture', hashtags: [], accountId: null, status: 'draft', attachments: [{ assetId: imgId, altText: '' }] })
  const pl = runs.plan(fromDraftsCfg({ draftIds: [withImage.id, own[0]!.id] }))
  check('drafts: the summary counts images already on the chosen posts', pl.ok && pl.images === 1 && pl.fromDrafts === 2, JSON.stringify([pl.images, pl.fromDrafts]))
  await drafts.remove(withImage.id)
}
check('… no AI provider needed', runs.plan({ ...fromDraftsCfg(), content: { ...fromDraftsCfg().content, prompt: '' } }).ok)
check('drafts: none chosen → blocked', runs.plan(fromDraftsCfg({ draftIds: [] })).problems.some((p) => p.blocking && p.message.includes('Choose the drafts')))
check('drafts: "save drafts only" makes no sense → blocked', !runs.plan({ ...fromDraftsCfg(), actions: { ...base().actions, publish: false, saveDrafts: true } }).ok)
let calls0 = genCalls
const pubBefore = published.length
const rd = await runs.start(fromDraftsCfg())
check('drafts run: published, nothing generated', (await waitFor(() => runs.details(rd.id).run.status === 'completed', 8000)) && published.length - pubBefore === 3 && genCalls === calls0, runs.details(rd.id).run.status)
let rdItems = itemsOf(rd.id)
check('… each post IS your draft (same id, text unchanged), marked as yours', rdItems.length === 3 && rdItems.every((i, n) => i.fromDraft && i.draftId === own[n]!.id && i.text === own[n]!.body), JSON.stringify(rdItems.map((i) => [i.fromDraft, i.text])))
check('… spread over the profiles in order (Alpha, Beta, Alpha)', rdItems.map((i) => i.accountId).join() === [A, B, A].join())
check('… drafts now published', (await Promise.all(own.map((d) => drafts.get(d.id)))).every((d) => d.status === 'published'))
check('drafts: already published drafts are refused', runs.plan(fromDraftsCfg()).problems.some((p) => p.blocking && p.message.includes('already scheduled, published or deleted')))

const mixed = [await mk('Mixed run: my post A'), await mk('Mixed run: my post B')]
calls0 = genCalls
const imgs0 = imgCalls
const mixedCfg: AutomationConfig = { ...base(), mode: 'manual-approval', content: { ...base().content, source: 'mixed', draftIds: mixed.map((d) => d.id) } }
plan = runs.plan(mixedCfg)
check('mixed: plan = 2 drafts + 2 generated, images for all 4 (drafts have none)', plan.ok && plan.fromDrafts === 2 && plan.generations === 2 && plan.posts === 4 && plan.images === 4, JSON.stringify([plan.fromDrafts, plan.generations, plan.posts, plan.images]))
const rm = await runs.start(mixedCfg)
check('mixed run: all 4 waiting for approval', await waitFor(() => runs.details(rm.id).run.counts.awaitingApproval === 4, 8000), JSON.stringify(runs.details(rm.id).run.counts))
const rmItems = itemsOf(rm.id)
check('… your drafts first, then generated posts', rmItems[0]!.fromDraft && rmItems[1]!.fromDraft && !rmItems[2]!.fromDraft && !rmItems[3]!.fromDraft && rmItems[0]!.text === mixed[0]!.body && rmItems[2]!.text!.startsWith('Generated post'))
check('… images generated for the drafts too (they had none)', imgCalls - imgs0 === 4 && rmItems.every((i) => i.image === 'attached' && i.imageAssetId))
check('… the AI was asked only for the generated slots', genCalls - calls0 >= 1)
check('regenerate refused for your own draft', (await errOf(runs.regenerate(rm.id, rmItems[0]!.id))).includes('one of your drafts'))
check('regenerate allowed for a generated post', (await errOf(runs.regenerate(rm.id, rmItems[2]!.id))) === 'none')
runs.stop(rm.id)
check('stop: your drafts stay drafts (not deleted)', (await Promise.all(mixed.map((d) => drafts.get(d.id)))).every((d) => d.status === 'draft' || d.status === 'ready'))

const shared = await mk('One draft for every profile')
const sameCfg: AutomationConfig = { ...base(), content: { ...base().content, source: 'drafts', draftIds: [shared.id], generateImages: false }, targets: { ...base().targets, distribution: 'same', allowDuplicates: true }, schedule: { ...base().schedule, postsPerProfile: 1 } }
plan = runs.plan(sameCfg)
check('drafts + same: one draft → one post per profile', plan.ok && plan.posts === 2 && plan.fromDrafts === 1, JSON.stringify([plan.posts, plan.fromDrafts]))
const rs = await runs.start(sameCfg)
check('… published on both', await waitFor(() => runs.details(rs.id).run.status === 'completed', 8000))
const rsItems = itemsOf(rs.id)
check('… first profile posts the draft, the other an independent copy with the same text', rsItems[0]!.draftId === shared.id && rsItems[1]!.draftId !== shared.id && rsItems[1]!.text === shared.body && rsItems.every((i) => i.scheduleStatus === 'completed'))

// Repost campaign (the simplified campaign form): no posts needed, one repost task per post link,
// one of your accounts each; the run time becomes the task's due time.
{
  db.run("UPDATE automation_runs SET status = 'stopped' WHERE status IN ('generating', 'awaiting-approval', 'paused', 'publishing')")
  const runAt = new Date(Date.now() + 2 * 3_600_000).toISOString()
  const repostCfg: AutomationConfig = {
    ...base(),
    name: 'Repost campaign',
    content: { ...base().content, source: 'drafts', draftIds: [], generateText: false, generateImages: false },
    actions: { ...base().actions, publish: false, saveDrafts: false, repost: true, engagementLinks: ['https://x.com/someone_else/status/1888000000000000001'] },
    schedule: { ...base().schedule, when: 'schedule', startAt: runAt }
  }
  const rp = runs.plan(repostCfg)
  check('repost campaign: valid without selecting posts; one repost task planned', rp.ok && rp.posts === 0 && rp.engagementTasks === 1, JSON.stringify(rp.problems))
  const pubBefore = published.length
  const rr = await runs.start(repostCfg)
  const ritems = itemsOf(rr.id)
  const task = db.get<{ kind: string; due_at: string | null; status: string }>('SELECT kind, due_at, status FROM engagement_tasks WHERE id = (SELECT engagement_task_id FROM run_items WHERE run_id = :id)', { id: rr.id })
  check('… a repost task for one account, due at the campaign run time, nothing published', ritems.length === 1 && ritems[0]!.kind === 'engagement' && task?.kind === 'repost' && task.due_at === runAt && task.status === 'open' && published.length === pubBefore, JSON.stringify(task))
  check('… the campaign completes (the repost itself is done by you)', await waitFor(() => runs.details(rr.id).run.status === 'completed', 4000), runs.details(rr.id).run.status)
  // Comment campaign: your comment text, one of your accounts per post (never the same comment
  // from several accounts), and the campaign result follows the task's real status.
  db.run("UPDATE automation_runs SET status = 'stopped' WHERE status IN ('generating', 'awaiting-approval', 'paused', 'publishing')")
  const commentCfg: AutomationConfig = {
    ...repostCfg,
    name: 'Comment campaign',
    actions: { ...repostCfg.actions, repost: false, comment: true, commentText: 'Great write-up — the section on caching helped me.', engagementLinks: ['https://x.com/author_one/status/1888000000000000011', 'https://x.com/author_two/status/1888000000000000012'] }
  }
  check('comment campaign: comment text required', runs.plan({ ...commentCfg, actions: { ...commentCfg.actions, commentText: ' ' } }).problems.some((p) => p.blocking && p.message.includes('comment text')))
  const cplan = runs.plan(commentCfg)
  check('comment campaign: one comment task per post', cplan.ok && cplan.engagementTasks === 2, JSON.stringify(cplan.problems))
  const cr = await runs.start(commentCfg)
  const ctasks = db.all<{ link_id: string; account_id: string; kind: string; reply_text: string; due_at: string | null }>('SELECT link_id, account_id, kind, reply_text, due_at FROM engagement_tasks WHERE id IN (SELECT engagement_task_id FROM run_items WHERE run_id = :id)', { id: cr.id })
  check('… reply tasks carry your comment and the run time; each post handled by one account', ctasks.length === 2 && ctasks.every((t) => t.kind === 'reply' && t.reply_text === 'Great write-up — the section on caching helped me.' && t.due_at === runAt) && new Set(ctasks.map((t) => t.link_id)).size === 2, JSON.stringify(ctasks))
  check('… the work is shared out between your accounts (not one account for everything)', new Set(ctasks.map((t) => t.account_id)).size === 2)
  const citems = itemsOf(cr.id)
  check('… each result records profile/account, target post, action', citems.every((i) => i.kind === 'engagement' && i.accountId && i.text?.startsWith('Comment on https://x.com/') && i.engagementStatus === 'open'))
  const firstTask = db.get<{ id: string }>('SELECT engagement_task_id AS id FROM run_items WHERE run_id = :id ORDER BY position LIMIT 1', { id: cr.id })!
  engagement.setStatus([firstTask.id], 'done')
  check('… marking the task done shows as done in the campaign results', itemsOf(cr.id).some((i) => i.engagementStatus === 'done'))
  const again = runs.plan(commentCfg)
  const second = await runs.start(commentCfg)
  check('… running it again creates no task: the same comment can’t come from another of your accounts, nor twice from one', itemsOf(second.id).length === 0 && again.ok, JSON.stringify(itemsOf(second.id).map((i) => [i.accountId, i.text])))
  check('post campaign still needs posts', runs.plan({ ...repostCfg, actions: { ...repostCfg.actions, publish: true, repost: false, engagementLinks: [] } }).problems.some((p) => p.blocking && p.message.includes('Choose the drafts')))
}

// "same" with no interval: each slot still gets its own text (grouped by slot, not by time)
const slotCfg: AutomationConfig = { ...base(), mode: 'manual-approval', content: { ...base().content, generateImages: false }, targets: { ...base().targets, distribution: 'same', allowDuplicates: true }, schedule: { ...base().schedule, postsPerProfile: 2, intervalMinutes: 0 } }
const rslot = await runs.start(slotCfg)
check('same + interval 0: 4 posts waiting', await waitFor(() => runs.details(rslot.id).run.counts.awaitingApproval === 4, 8000))
const slotItems = itemsOf(rslot.id)
const perProfile = (acc: string) => slotItems.filter((i) => i.accountId === acc).map((i) => i.text)
check('… a profile never gets the same text twice; slots shared across profiles', new Set(perProfile(A)).size === 2 && new Set(perProfile(B)).size === 2 && perProfile(A).join() === perProfile(B).join(), JSON.stringify(slotItems.map((i) => [i.accountId?.slice(0, 2), i.text])))
runs.stop(rslot.id)

db.close()
console.log(results.join('\n'))
console.log(`\n${results.filter((x) => x.startsWith('FAIL')).length} failed of ${results.length}`)
process.exit(0)
