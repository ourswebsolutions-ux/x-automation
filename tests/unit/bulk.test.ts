// Bulk posts and comments pasted from ChatGPT (no AI service involved): the parser, the checks, the
// one-transaction bulk save (duplicates, repeated requests, failures), saved comments, and campaigns
// that use them — real services and database; the engine is scripted (nothing here touches x.com).
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
import { RunService, pairComments } from '../../src/main/services/automation/runService'
import { bulkSave } from '../../src/main/services/drafts/bulk'
import { CommentDraftService } from '../../src/main/services/drafts/commentDraftService'
import { DraftService } from '../../src/main/services/drafts/draftService'
import { EngagementService } from '../../src/main/services/links/engagementService'
import { Notifier } from '../../src/main/services/notifications/notifier'
import { PublishHandler } from '../../src/main/services/publishing/publishHandler'
import { PublishingService } from '../../src/main/services/publishing/publishingService'
import { parsePostUrl } from '../../src/main/services/publishing/postUrl'
import { QueueService } from '../../src/main/services/queue/queueService'
import { BULK_MAX_ITEMS, bulkItemProblems, parseBulk, reviewItems } from '../../src/shared/lib/bulkParse'
import { choicesFrom, defaultChoices, toConfig } from '../../src/shared/lib/campaign'

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
const texts = (s: string) => parseBulk(s).items.map((i) => i.text)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const throws = (fn: () => unknown, pattern: RegExp) => {
  try {
    fn()
    return false
  } catch (e) {
    return pattern.test(String((e as Error).message))
  }
}
const rejects = async (fn: () => Promise<unknown>, pattern: RegExp) => {
  try {
    await fn()
    return false
  } catch (e) {
    return pattern.test(String((e as Error).message))
  }
}

// ── 1. Parsing what ChatGPT writes ──
const chatgpt = `Sure! Here are 3 X posts about marketing:

1. Your first post #Example #Marketing
2. Your second post, with 3 tips & a question? @alice https://example.com/a?b=1 🚀 #Business #Growth
3. Your third post — “quotes”, commas, 100% numbers #Technology #Innovation

Let me know if you’d like more posts or a different tone!`
const p1 = parseBulk(chatgpt)
check('numbered ChatGPT list: 3 posts, numbering removed', p1.format === 'numbered' && same(p1.items.map((i) => i.text), ['Your first post #Example #Marketing', 'Your second post, with 3 tips & a question? @alice https://example.com/a?b=1 🚀 #Business #Growth', 'Your third post — “quotes”, commas, 100% numbers #Technology #Innovation']), JSON.stringify(p1.items))
check('… the introduction and the closing note are not counted as posts (and are listed as left out)', p1.items.length === 3 && p1.ignored.map((i) => i.reason).join('|') === 'Introduction (before item 1)|Closing note (after the last item)', JSON.stringify(p1.ignored))
check('… hashtags, @mentions, links, emojis and punctuation kept exactly', p1.items[1]!.text.includes('@alice https://example.com/a?b=1 🚀 #Business #Growth') && p1.items[2]!.text.includes('“quotes”, commas, 100%'))
check('… the line where each post starts', same(p1.items.map((i) => i.line), [3, 4, 5]))
check('other numbering styles: "1)", "**2.**", "Post 3:", "Tweet #4 -"', same(texts('1) one\n**2.** two\nPost 3: three\nTweet #4 - four'), ['one', 'two', 'three', 'four']))
check('a numbered post can span several lines (and paragraphs): it ends at the next number', same(texts('1. First line\nsecond line #tag\n\nstill post one\n2. Post two\n3. Post three'), ['First line\nsecond line #tag\n\nstill post one', 'Post two', 'Post three']))
check('numbers that belong to the text are kept (a "3." or "1)" inside a post that isn’t the next number)', same(texts('1. My 3 tips:\n1) plan\n3. not next\n2. Second\n3. Third'), ['My 3 tips:\n1) plan\n3. not next', 'Second', 'Third']))
check('times, decimals and years are not list numbers ("10:30", "1.5x", "2024 -")', same(texts('1. Meet at 10:30 today\n2. Grew 1.5x in 2024 - wow\n3. Done'), ['Meet at 10:30 today', 'Grew 1.5x in 2024 - wow', 'Done']))
check('a second batch numbered 101, 102, … works', same(texts('101. a\n102. b\n103. c'), ['a', 'b', 'c']))
check('one post per line (no numbers): every line is a post', parseBulk('First #a\nSecond @b\nThird https://x.com').format === 'lines' && same(texts('First #a\nSecond @b\nThird https://x.com'), ['First #a', 'Second @b', 'Third https://x.com']))
check('blank-line separated: each block is one post, with its line breaks', parseBulk('Line one\nline two\n\nPost two\n\nPost three').format === 'paragraphs' && same(texts('Line one\nline two\n\nPost two\n\nPost three'), ['Line one\nline two', 'Post two', 'Post three']))
check('… and the format is explained in the preview (never guessed silently)', parseBulk('a\nb\n\nc').notes.some((n) => /blank lines/.test(n)) && parseBulk('a\nb').notes.some((n) => /One item per line/.test(n)))
check('bullets ("- ") are removed when the list uses them', same(texts('- one #a\n- two\n- three'), ['one #a', 'two', 'three']))
check('unnumbered paste: ChatGPT’s intro and closing are left out', same(texts('Here are your posts:\nOne\nTwo\nLet me know if you need more.'), ['One', 'Two']))
check('headings and separators between numbered items are not part of a post', same(texts('### Motivation\n1. One\n---\n**Growth**\n\n2. Two'), ['One', 'Two']))
check('a post wrapped in quotes loses only the wrapping quotes', same(texts('1. "Quoted post"\n2. Has "inner" quotes'), ['Quoted post', 'Has "inner" quotes']))
check('an unclear last paragraph is kept and pointed out', (() => {
  const r = parseBulk('1. One\n2. Two\n\nAnother paragraph that might be a note')
  return r.items[1]!.text === 'Two\n\nAnother paragraph that might be a note' && r.notes.some((n) => /Item 2 has more than one paragraph/.test(n))
})())
check('empty paste: nothing detected', parseBulk('  \n\n ').items.length === 0 && parseBulk('').format === 'empty')
check('Windows line endings', same(texts('1. a\r\n2. b\r\n'), ['a', 'b']))

const list300 = Array.from({ length: 300 }, (_, i) => `${i + 1}. Post number ${i + 1} about growth #Tip${i + 1}`).join('\n')
check('300 numbered posts → "300 detected"', parseBulk(`Here are 300 posts:\n\n${list300}\n\nHope these help!`).items.length === 300)
const list301 = Array.from({ length: 301 }, (_, i) => `${i + 1}. Post ${i + 1}`).join('\n')
check('301 are detected too (the limit is enforced when saving, with a clear message)', parseBulk(list301).items.length === 301 && BULK_MAX_ITEMS === 300)

// ── 2. Checks per item ──
check('empty item → blocking', bulkItemProblems('   ', 'post', 'standard')[0]?.blocking === true)
check('281 characters on the standard limit → blocking, with the reason (never cut)', /over X’s 280 limit/.test(bulkItemProblems('x'.repeat(281), 'post', 'standard')[0]?.message ?? ''))
check('… allowed with Longer posts (X Premium)', bulkItemProblems('x'.repeat(281), 'post', 'premium').length === 0)
check('emoji count twice, links count 23 (X’s rules)', bulkItemProblems(`${'🚀'.repeat(140)}`, 'post', 'standard').length === 0 && bulkItemProblems(`${'🚀'.repeat(141)}`, 'post', 'standard').length === 1 && bulkItemProblems(`${'a'.repeat(256)} https://example.com/${'x'.repeat(200)}`, 'post', 'standard').length === 0 && bulkItemProblems(`${'a'.repeat(257)} https://example.com/${'x'.repeat(200)}`, 'post', 'standard').length === 1)
check('comments longer than 4,000 characters → blocking', bulkItemProblems('x'.repeat(4001), 'comment', 'premium')[0]?.blocking === true)
const rv = reviewItems(['A post', 'a  POST', 'Other'], 'post', 'standard')
check('repeats within the list are marked (same words, ignoring spacing and case)', rv[1]!.duplicateOf === 0 && rv[0]!.duplicateOf === null && rv[2]!.duplicateOf === null)

// ── 3. Saving in bulk ──
const file = process.argv[2]!
for (const s of ['', '-wal', '-shm']) rmSync(file + s, { force: true })
const db = new SqliteDatabase(file).open()
check('migrate → v16 (bulk content)', migrate(db, log as never) === 16)
check('v16 adds the comment_drafts and bulk_saves tables (nothing else changes)', ['comment_drafts', 'bulk_saves'].every((t) => db.get(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = :t`, { t })))
const repos = createSqliteRepositories(db)
const assets = new AssetRepository(db)
const drafts = new DraftService(repos, db, assets, log as never)
const comments = new CommentDraftService(db, log as never)
const draftCount = () => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM drafts')!.n
const uuid = () => crypto.randomUUID()

const items300 = parseBulk(list300).items.map((i) => ({ text: i.text }))
const req1 = uuid()
const r300 = await drafts.saveMany({ requestId: req1, items: items300, lengthProfile: 'standard' })
check('Save All: 300 posts → 300 separate drafts', r300.saved.length === 300 && r300.skipped.length === 0 && draftCount() === 300 && !r300.repeated)
const list = await drafts.list()
check('… listed like other drafts, in the pasted order (post 1 first), text unchanged, status Draft', list[0]!.body === 'Post number 1 about growth #Tip1' && list[299]!.body === 'Post number 300 about growth #Tip300' && list.every((d) => d.status === 'draft' && d.hashtags.length === 0 && d.origin === 'manual'))
const again = await drafts.saveMany({ requestId: req1, items: items300, lengthProfile: 'standard' })
check('the same request again (double click / retry) saves nothing new and returns the first result', again.repeated && again.saved.length === 300 && draftCount() === 300 && same(again.saved, r300.saved))
const sameTexts = await drafts.saveMany({ requestId: uuid(), items: items300.slice(0, 3), lengthProfile: 'standard' })
check('a new request with texts that are already saved: skipped as "Already saved"', sameTexts.saved.length === 0 && sameTexts.skipped.length === 3 && sameTexts.skipped.every((s) => /Already saved/.test(s.reason)) && draftCount() === 300)
check('more than 300 in one save → refused, nothing saved', await rejects(() => drafts.saveMany({ requestId: uuid(), items: Array.from({ length: 301 }, (_, i) => ({ text: `Extra ${i}` })), lengthProfile: 'standard' }), /Up to 300/) && draftCount() === 300)
check('an empty save → refused', await rejects(() => drafts.saveMany({ requestId: uuid(), items: [], lengthProfile: 'standard' }), /Nothing to save/))
const mixed = await drafts.saveMany({ requestId: uuid(), items: [{ text: 'Valid one #ok' }, { text: '   ' }, { text: 'x'.repeat(300) }, { text: 'valid ONE #ok' }, { text: 'Valid two' }], lengthProfile: 'standard' })
check('partial: valid posts saved; empty, too long and repeated ones reported by item, not saved', same(mixed.saved.map((s) => s.index), [0, 4]) && same(mixed.skipped.map((s) => s.index), [1, 2, 3]) && /Empty/.test(mixed.skipped[0]!.reason) && /280/.test(mixed.skipped[1]!.reason) && /Same text as item 1/.test(mixed.skipped[2]!.reason) && draftCount() === 302, JSON.stringify(mixed.skipped))
// A failure part-way: the transaction keeps the database unchanged (and the request can be sent again).
const failReq = uuid()
const before = draftCount()
const failed = throws(
  () =>
    bulkSave(db, 'post', { requestId: failReq, items: [{ text: 'T1' }, { text: 'T2' }, { text: 'T3' }], lengthProfile: 'standard' }, [], (text, index) => {
      if (index === 2) throw new Error('disk full')
      db.run("INSERT INTO drafts (id, body, hashtags, account_id, status, origin, created_at, updated_at) VALUES (:id, :b, '[]', NULL, 'draft', 'manual', 'x', 'x')", { id: uuid(), b: text })
      return 'id'
    }),
  /disk full/
)
check('a failure during the save rolls everything back: no drafts, no record of the request', failed && draftCount() === before && !db.get('SELECT 1 AS x FROM bulk_saves WHERE id = :id', { id: failReq }))
const retried = await drafts.saveMany({ requestId: failReq, items: [{ text: 'T1' }, { text: 'T2' }, { text: 'T3' }], lengthProfile: 'standard' })
check('… so retrying the same request after a failure saves it (once)', retried.saved.length === 3 && !retried.repeated && draftCount() === before + 3)
check('the same request id twice in a row can’t interleave (second returns the first result)', await (async () => {
  const id = uuid()
  const [a, b] = await Promise.all([drafts.saveMany({ requestId: id, items: [{ text: 'Race A' }], lengthProfile: 'standard' }), drafts.saveMany({ requestId: id, items: [{ text: 'Race A' }], lengthProfile: 'standard' })])
  return a.saved.length === 1 && b.repeated && db.get<{ n: number }>("SELECT COUNT(*) AS n FROM drafts WHERE body = 'Race A'")!.n === 1
})())

// ── 4. Saved comments ──
const commentList = Array.from({ length: 300 }, (_, i) => `${i + 1}. Great point about ${i + 1} — thanks @author!`).join('\n')
const cAll = comments.saveMany({ requestId: uuid(), items: parseBulk(commentList).items.map((i) => ({ text: i.text })), lengthProfile: 'standard' })
check('Save All as Comment Drafts: 300 comments saved, in order, without a target', cAll.saved.length === 300 && comments.list().length === 300 && comments.list()[0]!.body === 'Great point about 1 — thanks @author!' && comments.list().every((c) => c.targetUrl === null && c.usedAt === null))
check('… a repeated request saves nothing new', comments.saveMany({ requestId: cAll.requestId, items: [{ text: 'whatever' }], lengthProfile: 'standard' }).repeated && comments.list().length === 300)
const cTarget = comments.saveMany({ requestId: uuid(), items: [{ text: 'For the launch post' }, { text: 'Second for launch' }], lengthProfile: 'standard', targetUrl: 'https://twitter.com/launch_co/status/1900000000000000901?s=20' })
check('comments with a target post: stored as the x.com link', cTarget.saved.length === 2 && comments.byIds(cTarget.saved.map((s) => s.id)).every((c) => c.targetUrl === 'https://x.com/launch_co/status/1900000000000000901'))
check('a target that isn’t a post link → refused (no comments saved)', throws(() => comments.saveMany({ requestId: uuid(), items: [{ text: 'Nope' }], lengthProfile: 'standard', targetUrl: 'https://example.com/post' }), /link to a post on X/) && comments.list().length === 302)
const edited = comments.update(cTarget.saved[1]!.id, { body: 'Edited comment', targetUrl: null })
check('a saved comment can be edited (text, target removed)', edited.body === 'Edited comment' && edited.targetUrl === null)
comments.remove(cTarget.saved[1]!.id)
check('… and deleted', comments.list().length === 301)

// Pairing: own target first, then the selected posts in order; one comment per post; no made-up targets.
const L = (n: number) => parsePostUrl(`https://x.com/news_${n}/status/19000000000000005${String(n).padStart(2, '0')}`)!
const pairs = pairComments(
  [
    { id: 'c1', body: 'one', targetUrl: null },
    { id: 'c2', body: 'two', targetUrl: 'https://x.com/news_2/status/1900000000000000502' },
    { id: 'c3', body: 'three', targetUrl: null },
    { id: 'c4', body: 'four', targetUrl: null }
  ],
  [L(1), L(2), L(3)]
)
check('pairing: a comment’s own target first, the others take the selected posts in order', pairs[0]!.target?.postId === L(1).postId && pairs[1]!.target?.postId === L(2).postId && pairs[2]!.target?.postId === L(3).postId)
check('… one comment per post: a 4th comment with no post left is skipped with the reason (no target invented)', pairs[3]!.target === null && /no post left/.test(pairs[3]!.reason ?? ''))
const pairs2 = pairComments([{ id: 'c1', body: 'one', targetUrl: null }], [L(1), L(2)])
check('… a selected post without a comment is reported', pairs2.length === 2 && pairs2[1]!.comment === null && /no comment left/.test(pairs2[1]!.reason ?? ''))

// ── 5. Campaigns with them: profiles, posts, comments — started immediately ──
const at = new Date().toISOString()
const ACC = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const PRO = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`
for (let n = 1; n <= 3; n++) {
  db.run("INSERT INTO browser_profiles (id, external_id, name, synced_at, first_seen_at, availability, run_state) VALUES (:id, :ext, :name, :at, :at, 'available', 'closed')", { id: PRO(n), ext: String(300 + n), name: `Profile ${n}`, at })
  db.run("INSERT INTO accounts (id, label, handle, identity, identity_confirmed_at, browser_profile_id, linked_at, enabled, created_at, updated_at) VALUES (:id, :label, :handle, 'confirmed', :at, :pid, :at, 1, :at, :at)", { id: ACC(n), label: `Account ${n}`, handle: `acct_${n}`, pid: PRO(n), at })
}
const accounts = new AccountRepository(db)
const queueRepo = new QueueRepository(db)
const prefs = { notifications: { taskFailures: { inApp: true, desktop: false }, scheduleReminders: { inApp: true, desktop: false }, systemNotices: { inApp: true, desktop: false } }, defaults: { textProviderId: null, imageProviderId: null } }
const notifier = new Notifier({ preferences: { get: () => prefs } as never, log: log as never })
notifier.attach(() => {})
notifier.rendererListening()
const postLinks = new PostLinkRepository(db)
const calls: { cmd: string; params: Record<string, unknown> }[] = []
let nextId = 8000
const engine = {
  killNow() {},
  async request(cmd: string, params: Record<string, unknown>, opts?: { onProgress?: (s: string) => void }) {
    calls.push({ cmd, params })
    if (cmd === 'x.findPost') return { found: false }
    for (const s of ['attach', 'open-post', 'submit', 'confirm']) opts?.onProgress?.(s)
    const id = String(nextId++)
    return { url: `https://x.com/acct/status/${id}`, postId: id, handle: 'acct', accountCheck: 'match', verifiedBy: 'post-link' }
  }
}
const ix = { debuggingAddressFor: (e: number) => `127.0.0.1:${9000 + e}`, openProfile: async () => ({}), closeProfile: async () => ({}) }
const queue = new QueueService({ repo: queueRepo, settings: repos.settings, log: log as never, onChange() {}, backoffMs: () => 30 })
const publishing = new PublishingService({ db, drafts: repos.drafts, accounts, schedules: new ScheduleRepository(db), postLinks, queue, queueRepo, duplicateDraft: (id) => drafts.duplicate(id), settings: repos.settings, activity: repos.activity, notifier, log: log as never, onChange() {} })
publishing.updateSettings({ spacingMinutes: 0, maxAttempts: 2 })
const handlerDeps = { drafts: repos.drafts, accounts, postLinks, queueRepo, ixBrowser: ix as never, engine: engine as never, assetFile: () => null, settings: () => publishing.getSettings(), settle: (t: never, s: never) => publishing.settleTask(t, s), log: log as never, notifier }
for (const kind of ['publish', 'reply', 'repost'] as const) queue.register(new PublishHandler(handlerDeps, kind))
queue.start()
const engagement = new EngagementService({ repo: new EngagementRepository(db), links: postLinks, accounts, settings: repos.settings, ixBrowser: {} as never, engine: {} as never, log: log as never, onChange() {} })
const runs = new RunService({
  db, generator: {} as never, images: {} as never, drafts, comments, assets, accounts,
  accountService: { createFromProfiles: () => ({ changed: 0, skipped: [], accounts: [] }) } as never,
  profiles: new ProfileRepository(db), providers: { list: () => [] } as never, preferences: { get: () => prefs } as never,
  publishing, engagement, queue, notifier, log: log as never, onChange() {}
})
const settled = (id: string) => ['completed', 'failed', 'stopped'].includes(runs.details(id).run.status)

// 300 bulk drafts in one campaign, on 3 profiles: every post planned (room for all of them).
const all300 = r300.saved.map((s) => s.id)
const plan300 = runs.plan(toConfig({ ...defaultChoices(), action: 'post', draftIds: all300, seed: 7 }))
check('campaign: Select all 300 bulk drafts on 3 profiles → all 300 planned, one profile each, 100 per profile', plan300.ok && plan300.posts === 300 && plan300.postPreview.length === 300 && [ACC(1), ACC(2), ACC(3)].every((a) => plan300.postPreview.filter((p) => p.accountId === a).length === 100), JSON.stringify(plan300.problems))
const planOne = runs.plan(toConfig({ ...defaultChoices(), action: 'post', draftIds: all300.slice(0, 5), seed: 7, profileScope: 'selected', profileIds: [PRO(2)] }))
check('campaign: only the chosen profile takes part when you choose profiles', planOne.ok && planOne.profiles.selected === 1 && planOne.postPreview.length === 5 && planOne.postPreview.every((p) => p.accountId === ACC(2)))
check('… choosing no profiles blocks the start', !runs.plan(toConfig({ ...defaultChoices(), action: 'post', draftIds: all300.slice(0, 2), profileScope: 'selected', profileIds: [] })).ok)

check('an older saved setup with a run time opens without one (it runs now)', (() => {
  const base = toConfig({ ...defaultChoices(), action: 'post', draftIds: all300.slice(0, 2) })
  const old = { ...base, schedule: { ...base.schedule, when: 'schedule' as const, startAt: new Date(Date.now() + 86_400_000).toISOString() } }
  const reopened = toConfig(choicesFrom(old))
  return !runs.plan(old).ok && reopened.schedule.when === 'now' && reopened.schedule.startAt === null && runs.plan(reopened).ok
})())
check('missing selections are refused with a reason: no posts, no comments, no post links', (() => {
  const noPosts = runs.plan(toConfig({ ...defaultChoices(), action: 'post', draftIds: [] }))
  const noComment = runs.plan(toConfig({ ...defaultChoices(), action: 'comment', repostLinks: ['https://x.com/a_b/status/1900000000000000801'] }))
  const noLinks = runs.plan(toConfig({ ...defaultChoices(), action: 'repost', repostLinks: [] }))
  return !noPosts.ok && noPosts.problems.some((p) => /Choose the drafts/.test(p.message)) && !noComment.ok && noComment.problems.some((p) => /Write the comment/.test(p.message)) && !noLinks.ok && noLinks.problems.some((p) => /post links/.test(p.message))
})())

// Comments from saved comments: Run now — each comment on one selected post, one comment per post.
const targets = [1, 2].map((n) => `https://x.com/target_${n}/status/19000000000000007${n}0`)
const picked = cAll.saved.slice(0, 3).map((s) => s.id)
const commentCfg = toConfig({ ...defaultChoices(), name: 'Comments', action: 'comment', repostLinks: targets, commentIds: picked, seed: 11 })
const cPlan = runs.plan(commentCfg)
const assigned = cPlan.engagementPreview.filter((p) => !p.skipped)
check('comment campaign: 3 comments, 2 posts → 2 comments planned, the 3rd skipped with its reason', cPlan.ok && assigned.length === 2 && cPlan.engagementPreview.filter((p) => p.skipped).length === 1 && /no post left/.test(cPlan.engagementPreview.find((p) => p.skipped)!.skipped!), JSON.stringify(cPlan.engagementPreview.map((p) => [p.url.slice(-4), p.skipped])))
check('… each post gets its own different comment, from a different account (never several accounts on one post)', new Set(assigned.map((a) => a.url)).size === 2 && new Set(assigned.map((a) => a.text)).size === 2 && new Set(assigned.map((a) => a.accountId)).size === 2)
check('… the preview tells you what is skipped', cPlan.problems.some((p) => /no post to go on/.test(p.message)))
const cRun = await runs.start(commentCfg)
await waitFor(() => settled(cRun.id), 10_000)
const replies = calls.filter((c) => c.cmd === 'x.publish' && c.params.inReplyTo)
check('Run campaign: starts at once (no date or time) and posts exactly the previewed comments on their posts', replies.length === 2 && assigned.every((a) => replies.some((r) => r.params.text === a.text && r.params.inReplyTo === a.url.split('/').pop())), JSON.stringify(replies.map((r) => [r.params.text, r.params.inReplyTo])))
check('… the run completes; the used comments are marked used, the skipped one is not', runs.details(cRun.id).run.status === 'completed' && comments.byIds(picked).filter((c) => c.usedAt).length === 2, runs.details(cRun.id).run.status)
check('starting the same campaign again while it runs is refused (no duplicate execution)', await (async () => {
  const cfg = toConfig({ ...defaultChoices(), name: 'Once', action: 'comment', repostLinks: ['https://x.com/target_9/status/1900000000000000790'], commentIds: [cAll.saved[10]!.id], seed: 12 })
  const first = await runs.start(cfg)
  const second = await rejects(() => runs.start(cfg), /just started/)
  await waitFor(() => settled(first.id), 10_000)
  return second && calls.filter((c) => c.cmd === 'x.publish' && c.params.inReplyTo && c.params.text === comments.byIds([cAll.saved[10]!.id])[0]!.body).length === 1
})())
check('comments with their own target need no selected posts; comments without a target and no posts → blocked (no target invented)', (() => {
  const own = comments.saveMany({ requestId: uuid(), items: [{ text: 'Own target comment' }], lengthProfile: 'standard', targetUrl: 'https://x.com/own_t/status/1900000000000000999' })
  const okPlan = runs.plan(toConfig({ ...defaultChoices(), action: 'comment', repostLinks: [], commentIds: own.saved.map((s) => s.id), seed: 3 }))
  const noTarget = runs.plan(toConfig({ ...defaultChoices(), action: 'comment', repostLinks: [], commentIds: [comments.list().find((c) => !c.targetUrl)!.id], seed: 3 }))
  return okPlan.ok && okPlan.engagementPreview[0]!.url === 'https://x.com/own_t/status/1900000000000000999' && !noTarget.ok && noTarget.problems.some((p) => /Select the posts to comment on/.test(p.message))
})())
check('the single written comment still works (one post), unchanged', (() => {
  const p = runs.plan(toConfig({ ...defaultChoices(), action: 'comment', repostLinks: targets, commentText: 'One written comment', seed: 5 }))
  return p.ok && p.engagementPreview.filter((r) => !r.skipped).length === 1 && p.engagementPreview.find((r) => !r.skipped)!.text === 'One written comment'
})())
check('a saved post campaign runs immediately too: the selected bulk drafts are published', await (async () => {
  const before = calls.filter((c) => c.cmd === 'x.publish' && !c.params.inReplyTo).length
  const run = await runs.start(toConfig({ ...defaultChoices(), name: 'Bulk posts now', action: 'post', draftIds: all300.slice(0, 3), seed: 9 }))
  await waitFor(() => settled(run.id), 15_000)
  return runs.details(run.id).run.status === 'completed' && calls.filter((c) => c.cmd === 'x.publish' && !c.params.inReplyTo).length - before === 3
})())

await queue.stop()
db.close()
console.log(results.join('\n'))
const failedChecks = results.filter((r) => r.startsWith('FAIL')).length
console.log(`\n${results.length - failedChecks}/${results.length} passed`)
process.exit(failedChecks ? 1 : 0)
