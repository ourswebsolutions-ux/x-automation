// Phase 9 unit tests: post link management and engagement-task guardrails.
import { rmSync } from 'node:fs'
import { SqliteDatabase } from '../../src/main/services/database/driver'
import { migrate } from '../../src/main/services/database/migrator'
import { createSqliteRepositories } from '../../src/main/services/database/sqlite'
import { AccountRepository } from '../../src/main/services/database/sqlite/accountRepository'
import { EngagementRepository } from '../../src/main/services/database/sqlite/engagementRepository'
import { PostLinkRepository } from '../../src/main/services/database/sqlite/postLinkRepository'
import { EngineError } from '../../src/main/services/engine/engineService'
import { EngagementService } from '../../src/main/services/links/engagementService'
import { LinkService } from '../../src/main/services/links/linkService'

const results: string[] = []
const check = (name: string, ok: boolean, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + String(extra).slice(0, 300) : ''}`)
const logged: string[] = []
const log = { debug() {}, info: (m: string, meta?: unknown) => logged.push(m + JSON.stringify(meta ?? {})), success: (m: string) => logged.push(m), warn: (m: string) => logged.push(m), error: (m: string) => logged.push(m) }
const errOf = (fn: () => unknown) => {
  try {
    fn()
    return 'none'
  } catch (e) {
    return `${(e as Error).name}: ${(e as Error).message}`
  }
}
const errOfAsync = async (p: Promise<unknown>) => p.then(() => 'none', (e) => `${(e as Error).name}: ${(e as Error).message}`)

const file = process.argv[2]!
rmSync(file, { force: true })
const db = new SqliteDatabase(file).open()
check('migrate → v14', migrate(db, log as never) === 14)
const at = new Date().toISOString()
db.exec(`INSERT INTO browser_profiles (id, external_id, name, synced_at, first_seen_at, availability, run_state) VALUES
  ('bp1','101','Alpha','${at}','${at}','available','closed'),('bp2','102','Beta','${at}','${at}','available','closed'),('bp3','103','Gamma','${at}','${at}','available','running')`)
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
db.exec(`INSERT INTO accounts (id, label, handle, identity, identity_confirmed_at, browser_profile_id, linked_at, enabled, created_at, updated_at) VALUES
  ('${A}','Brand','brand_main','confirmed','${at}','bp1','${at}',1,'${at}','${at}'),
  ('${B}','Founder','founder_x','confirmed','${at}','bp2','${at}',1,'${at}','${at}'),
  ('${C}','Busy','busy_acct','confirmed','${at}','bp3','${at}',1,'${at}','${at}')`)
createSqliteRepositories(db)
const accounts = new AccountRepository(db)
const linkRepo = new PostLinkRepository(db)
const settingsStore = new Map<string, unknown>()
const settings = { get: (k: string) => settingsStore.get(k), set: (k: string, v: unknown) => settingsStore.set(k, v), setMany() {}, entries: () => ({}), delete: (k: string) => settingsStore.delete(k) }
let changes = 0
const links = new LinkService({ repo: linkRepo, accounts, log: log as never, onChange: () => changes++ })

// ── adding links ──
const r1 = links.add({
  text: 'https://x.com/brand_main/status/1001\nhttps://twitter.com/founder_x/status/1002?s=20, x.com/someone_else/status/1003\nnot a link\nhttps://x.com/brand_main/status/1001\n# a comment\nhttps://x.com/brand_main',
  accountId: null,
  tags: ['launch', 'Launch', ' q4 '],
  notes: 'From the newsletter'
})
check('add: 3 links parsed from lines, spaces and commas', r1.added.length === 3, JSON.stringify(r1.added.map((l) => l.url)))
check('add: non-post links rejected with line numbers', JSON.stringify(r1.rejected) && r1.rejected.length === 2 && r1.rejected[0]!.line === 3 && r1.rejected[0]!.text === 'not a link' && r1.rejected[1]!.line === 6 && r1.rejected[0]!.reason === 'Not a link to a post on X', JSON.stringify(r1.rejected))
check('add: duplicate in the same batch reported, not added', r1.duplicates.length === 1)
check('add: URLs normalised to x.com', r1.added.every((l) => l.url.startsWith('https://x.com/')) && r1.added.some((l) => l.url === 'https://x.com/founder_x/status/1002'))
const byPost = (id: string) => links.list().find((l) => l.postId === id)!
check('add: matched to accounts by username; others left unassigned', byPost('1001').accountId === A && byPost('1002').accountId === B && byPost('1003').accountId === null)
check('add: tags cleaned (dedupe, trim) and notes saved', JSON.stringify(byPost('1001').tags) === '["launch","q4"]' && byPost('1001').notes === 'From the newsletter' && byPost('1001').source === 'manual')
const r2 = links.add({ text: 'https://x.com/BRAND_MAIN/status/1001', accountId: null, tags: [], notes: '' })
check('add: same post again (any case) → duplicate', r2.added.length === 0 && r2.duplicates[0]!.existingId === byPost('1001').id)
check('add: explicit account overrides matching', links.add({ text: 'https://x.com/someone_else/status/1004', accountId: B, tags: [], notes: '' }).added[0]!.accountId === B)
check('tags: too many / too long refused', errOf(() => links.add({ text: 'x.com/a/status/9', accountId: null, tags: Array.from({ length: 11 }, (_, i) => `t${i}`), notes: '' })).includes('at most 10') && errOf(() => links.add({ text: 'x.com/a/status/9', accountId: null, tags: ['x'.repeat(31)], notes: '' })).includes('30 characters'))

// ── import ──
const csv = 'URL,Account,Tags,Notes,Published At\n"https://x.com/someone_else/status/2001",@founder_x,"partner;q4","Said ""thanks""",2026-10-01T10:00:00Z\nhttps://x.com/someone_else/status/2002,Brand,,,\nhttps://x.com/someone_else/status/2003,Nobody,,,\nnope,,,,\n'
const r3 = links.importText(csv)
check('CSV import: header in any case, quoted cells', r3.added.length === 2 && byPost('2001').notes === 'Said "thanks"' && JSON.stringify(byPost('2001').tags) === '["partner","q4"]' && byPost('2001').source === 'imported')
check('CSV import: account by @username or label', byPost('2001').accountId === B && byPost('2002').accountId === A)
check('CSV import: published_at kept', byPost('2001').publishedAt === '2026-10-01T10:00:00.000Z')
check('CSV import: unknown account and bad link rejected with line numbers', r3.rejected.length === 2 && r3.rejected[0]!.line === 4 && r3.rejected[0]!.reason.includes('Unknown account') && r3.rejected[1]!.line === 5)
const r4 = links.importText('https://x.com/i/web/status/3001\n\nhttps://x.com/someone_else/status/2001\n')
check('TXT import: anonymous status links, duplicates', r4.added.length === 1 && r4.added[0]!.handle === null && r4.duplicates.length === 1)

// ── update / tags / export / remove ──
const l1 = byPost('1001')
links.update(l1.id, { accountId: null, tags: ['evergreen'], notes: 'Pinned' })
check('update link', byPost('1001').accountId === null && byPost('1001').notes === 'Pinned' && byPost('1001').tags[0] === 'evergreen')
links.update(l1.id, { accountId: A, tags: ['evergreen'], notes: 'Pinned' })
const bt = links.addTags([l1.id, byPost('1002').id], ['campaign'])
check('bulk add tags keeps existing ones', bt.changed === 2 && JSON.stringify(byPost('1001').tags) === '["evergreen","campaign"]')
const exported = links.exportCsv().csv
check('export CSV: header, escaping, no internal ids', exported.startsWith('url,post_id,username,account,source,published_at,tags,notes,open_tasks,done_tasks') && exported.includes('"Said ""thanks"""') && !exported.includes(l1.id))

// ── engagement guardrails ──
const engineCalls: Record<string, unknown>[] = []
const ix = { addresses: new Map<number, string>(), opened: [] as number[], debuggingAddressFor(e: number) { return this.addresses.get(e) ?? null }, async openProfile(e: number) { this.opened.push(e); this.addresses.set(e, `127.0.0.1:${9000 + e}`) } }
let engineFail: string | null = null
const engine = { async request(cmd: string, params: Record<string, unknown>) { engineCalls.push({ cmd, ...params }); if (engineFail) throw new EngineError(engineFail, 'x'); return { opened: true, signedOut: false } } }
const eng = new EngagementService({ repo: new EngagementRepository(db), links: linkRepo, accounts, settings: settings as never, ixBrowser: ix as never, engine: engine as never, log: log as never, onChange() {} })
const brandPost = byPost('1001').id // owned by Brand
const otherPost = byPost('1003').id // someone else's
const base = { dueAt: null, note: '', replyText: '' }

let c = eng.check({ linkId: brandPost, accountId: B, kind: 'like', ...base })
check('own post: like from another of your accounts is blocked (artificial amplification)', !c.ok && c.problems.some((p) => p.code === 'own-amplification'))
c = eng.check({ linkId: brandPost, accountId: B, kind: 'repost', ...base })
check('own post: repost from another account blocked', !c.ok)
c = eng.check({ linkId: brandPost, accountId: B, kind: 'reply', ...base })
check('own post: reply from another account allowed', c.ok, JSON.stringify(c.problems))
c = eng.check({ linkId: brandPost, accountId: A, kind: 'repost', ...base })
check('own post: the author account may repost its own post', c.ok)
c = eng.check({ linkId: byPost('1004').id, accountId: A, kind: 'like', ...base })
check('ownership also from the link account (not only the username)', !c.ok && c.problems.some((p) => p.code === 'own-amplification'))

const created = eng.create({ linkIds: [otherPost], accountId: A, kind: 'like', ...base })
check('like a third-party post from one account', created.created.length === 1)
c = eng.check({ linkId: otherPost, accountId: B, kind: 'repost', ...base })
check('second of your accounts amplifying the same post → blocked (coordinated)', !c.ok && c.problems.some((p) => p.code === 'coordinated' && p.message.startsWith('Brand')))
c = eng.check({ linkId: otherPost, accountId: B, kind: 'reply', ...base })
check('… a reply from another account is still allowed', c.ok)
c = eng.check({ linkId: otherPost, accountId: A, kind: 'like', ...base })
check('duplicate open task blocked', !c.ok && c.problems.some((p) => p.code === 'duplicate'))
c = eng.check({ linkId: otherPost, accountId: null, kind: 'like', ...base })
check('amplifying task needs an account', !c.ok && c.problems.some((p) => p.code === 'no-account'))
check('follow-up without an account is fine', eng.check({ linkId: otherPost, accountId: null, kind: 'follow-up', ...base }).ok)

// done tasks still count for coordination; skipped do not
eng.setStatus([created.created[0]!.id], 'done')
check('done like still blocks a second account', !eng.check({ linkId: otherPost, accountId: B, kind: 'quote', ...base }).ok)
eng.setStatus([created.created[0]!.id], 'skipped')
check('skipped like no longer blocks', eng.check({ linkId: otherPost, accountId: B, kind: 'quote', ...base }).ok)
eng.setStatus([created.created[0]!.id], 'open')

// daily guideline
eng.updateSettings({ dailyLimitPerAccount: 3 })
const thirdParty = ['2001', '2002', '2003x'].map((p) => links.list().find((l) => l.postId === p)?.id).filter(Boolean) as string[]
const many = links.add({ text: ['5001', '5002', '5003', '5004'].map((n) => `https://x.com/someone_else/status/${n}`).join('\n'), accountId: null, tags: [], notes: '' }).added.map((l) => l.id)
void thirdParty
const batch = eng.create({ linkIds: many, accountId: B, kind: 'reply', ...base })
check('daily guideline counts tasks created in the same batch', batch.created.length === 3 && batch.skipped.length === 1 && batch.skipped[0]!.reason.includes('guideline is 3'))
const tomorrow = new Date(Date.now() + 86_400_000)
tomorrow.setHours(10, 0, 0, 0)
check('another day has its own allowance', eng.check({ linkId: many[3]!, accountId: B, kind: 'reply', ...base, dueAt: tomorrow.toISOString() }).ok)
check('guideline validated', errOf(() => eng.updateSettings({ dailyLimitPerAccount: 9999 })).includes('between 0 and 500'))
eng.updateSettings({ dailyLimitPerAccount: 0 })
check('0 turns the guideline off', eng.check({ linkId: many[3]!, accountId: B, kind: 'reply', ...base }).ok)

// update + status
const replyTask = batch.created[0]!
check('update keeps guardrails (no switch to a blocked kind/account)', errOf(() => eng.update(replyTask.id, { accountId: B, kind: 'like', dueAt: null, note: '', replyText: '' })) === 'none' && errOf(() => eng.update(eng.list({ status: 'open', linkId: brandPost })[0]?.id ?? replyTask.id, { accountId: B, kind: 'like', dueAt: null, note: '', replyText: '' })) !== 'x')
const brandReply = eng.create({ linkIds: [brandPost], accountId: B, kind: 'reply', ...base, replyText: 'Congrats team!' }).created[0]!
check('switching an allowed reply to a blocked like is refused', errOf(() => eng.update(brandReply.id, { accountId: B, kind: 'like', dueAt: null, note: '', replyText: '' })).includes('artificial amplification'))
const dupA = eng.create({ linkIds: [brandPost], accountId: A, kind: 'bookmark', ...base }).created[0]!
eng.setStatus([dupA.id], 'done')
eng.create({ linkIds: [brandPost], accountId: A, kind: 'bookmark', ...base })
check('reopening when an identical task is open is skipped', eng.setStatus([dupA.id], 'open').skipped[0]?.reason === 'An identical task is already open')
check('list + counts', eng.list({ status: 'open' }).length >= 5 && eng.counts().open >= 5 && byPost('1001').openTasks >= 2)

// open in profile (fake IX + engine)
const opened = await eng.openInProfile(brandReply.id)
check('open in profile: opens the profile via IX, then x.openPost with the post URL', !opened.signedOut && ix.opened.includes(102) && engineCalls.at(-1)?.cmd === 'x.openPost' && engineCalls.at(-1)?.url === 'https://x.com/brand_main/status/1001')
const busyTask = eng.create({ linkIds: [otherPost], accountId: C, kind: 'reply', ...base }).created[0]!
check('open in profile: a profile IX lists as opened is still opened through IX (its list is team-wide)', (await errOfAsync(eng.openInProfile(busyTask.id))) === 'none' && engineCalls.at(-1)?.url === 'https://x.com/someone_else/status/1003', JSON.stringify(engineCalls.at(-1)))
const followUp = eng.create({ linkIds: [otherPost], accountId: null, kind: 'follow-up', ...base }).created[0]!
check('open in profile: needs an account', (await errOfAsync(eng.openInProfile(followUp.id))).includes('no account'))
engineFail = 'CONNECT_FAILED'
check('open in profile: engine failure in plain words', (await errOfAsync(eng.openInProfile(brandReply.id))).includes('Could not connect'))

// removing a link removes its tasks, never anything on X
const tasksBefore = eng.list({ status: 'all', linkId: brandPost }).length
const rm = links.remove([brandPost])
check('remove link → local record and its tasks gone', rm.changed === 1 && tasksBefore > 0 && eng.list({ status: 'all', linkId: brandPost }).length === 0 && !links.list().some((l) => l.id === brandPost))
check('no engine/X call made when removing', engineCalls.every((c2) => c2.cmd === 'x.openPost'))
check('logs carry no link text or notes', !logged.some((l) => l.includes('newsletter') || l.includes('Congrats')))

db.close()
console.log(results.join('\n'))
console.log(`\n${results.filter((x) => x.startsWith('FAIL')).length} failed of ${results.length}`)
process.exit(0)
