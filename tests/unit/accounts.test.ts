import { rmSync } from 'node:fs'
const ROOT = '../../src/main/services'
import { SqliteDatabase } from '../../src/main/services/database/driver'
import { migrate } from '../../src/main/services/database/migrator'
import { m001Initial } from '../../src/main/services/database/migrations/001_initial'
import { m002IxBrowserSync } from '../../src/main/services/database/migrations/002_ixbrowser_sync'
import { AccountRepository } from '../../src/main/services/database/sqlite/accountRepository'
import { ProfileRepository } from '../../src/main/services/database/sqlite/profileRepository'
import { AccountService } from '../../src/main/services/accounts/accountService'
void ROOT

const results: string[] = []
const check = (name: string, ok: boolean, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
const log = { debug() {}, info() {}, success() {}, warn() {}, error() {} }
const path = process.argv[2]!
const fresh = (p: string) => ['', '-wal', '-shm'].forEach((s) => rmSync(p + s, { force: true }))
const errName = (fn: () => unknown) => {
  try {
    fn()
    return 'none'
  } catch (e) {
    return `${(e as Error).name}: ${(e as Error).message}`
  }
}
const at = '2026-01-01T00:00:00.000Z'

// ── 1. Upgrade a v2 database that holds Phase 1-style account rows ──────────
fresh(path)
{
  const db = new SqliteDatabase(path).open()
  db.exec(m001Initial.sql)
  db.exec(m002IxBrowserSync.sql)
  db.exec('PRAGMA user_version = 2')
  db.exec('PRAGMA application_id = 1096307289')
  db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`)
  db.exec(`INSERT INTO schema_migrations VALUES (1,'initial','x','${at}'),(2,'ixbrowser_profile_sync','x','${at}')`)
  db.exec(`INSERT INTO browser_profiles (id, external_id, name, synced_at, first_seen_at) VALUES ('bp1','101','Alpha','${at}','${at}'),('bp2','102','Beta','${at}','${at}')`)
  db.exec(`INSERT INTO accounts (id, handle, display_name, browser_profile_id, group_name, status, last_active_at, tags) VALUES
    ('a1','Foo','Foo Inc','bp1','Brands','active','${at}','["retail"]'),
    ('a2','foo','Foo Dupe','bp1','Default','paused',NULL,'[]'),
    ('a3','bad-handle!','','bp2','Default','attention',NULL,'[]'),
    ('a4','plain','Plain',NULL,'Default','unlinked',NULL,'[]')`)
  db.exec(`INSERT INTO drafts (id, body, account_id, status, origin, created_at, updated_at) VALUES ('d1','hi','a2','draft','manual','${at}','${at}')`)
  db.exec(`INSERT INTO tasks (id, kind, status, account_id, label, created_at) VALUES ('t1','publish','queued','a3','x','${at}')`)
  db.exec(`INSERT INTO scheduled_posts (id, draft_id, account_id, run_at, status) VALUES ('s1','d1','a1','${at}','pending')`)
  db.exec(`INSERT INTO post_links (id, url, account_id, published_at) VALUES ('pl1','https://x.com/a/status/1','a1','${at}')`)
  db.close()
}
{
  const db = new SqliteDatabase(path).open()
  check('migrate v2 → v16 (via 003 account rebuild)', migrate(db, log) === 16)
  check('foreign_keys re-enabled after migration', db.pragma<number>('foreign_keys') === 1)
  check('foreign_key_check clean', db.all('PRAGMA foreign_key_check').length === 0)
  const rows = db.all<Record<string, unknown>>('SELECT * FROM accounts ORDER BY id')
  const by = Object.fromEntries(rows.map((r) => [r.id, r]))
  check('all 4 legacy rows preserved', rows.length === 4)
  check('a1 keeps handle as unverified + profile', by.a1?.handle === 'Foo' && by.a1?.identity === 'unverified' && by.a1?.browser_profile_id === 'bp1')
  check('a1 group/tags moved to notes', String(by.a1?.notes).includes('Group: Brands') && String(by.a1?.notes).includes('retail'))
  check('a2 case-clash handle dropped → unknown', by.a2?.handle === null && by.a2?.identity === 'unknown')
  check('a2 duplicate profile claim dropped', by.a2?.browser_profile_id === null && by.a2?.linked_at === null)
  check('a2 paused → disabled', by.a2?.enabled === 0)
  check('a3 invalid handle dropped; empty display name → label from handle', by.a3?.handle === null && by.a3?.label === 'bad-handle!' && by.a3?.browser_profile_id === 'bp2')
  check('a4 valid handle kept as unverified, unlinked, enabled', by.a4?.handle === 'plain' && by.a4?.identity === 'unverified' && by.a4?.browser_profile_id === null && by.a4?.enabled === 1)
  check('drafts/tasks/schedules/post links untouched', db.get<{ n: number }>("SELECT (SELECT COUNT(*) FROM drafts WHERE account_id='a2') + (SELECT COUNT(*) FROM tasks WHERE account_id='a3') + (SELECT COUNT(*) FROM scheduled_posts WHERE account_id='a1') + (SELECT COUNT(*) FROM post_links WHERE account_id='a1') AS n")?.n === 4)
  check('browser profiles untouched', db.get<{ n: number }>('SELECT COUNT(*) n FROM browser_profiles')?.n === 2)
  check('migrate idempotent at v16', migrate(db, log) === 16)
  check(
    'UNIQUE profile constraint enforced',
    errName(() => db.run("UPDATE accounts SET browser_profile_id='bp1', linked_at='x' WHERE id='a4'")).includes('constraint failed')
  )
  check('handle unique NOCASE', errName(() => db.run("UPDATE accounts SET handle='FOO', identity='unverified' WHERE id='a4'")).includes('constraint failed'))
  { const m = errName(() => db.run("UPDATE accounts SET handle='zzz', identity='unknown' WHERE id='a4'")); check('CHECK: handle requires identity', m.includes('constraint failed'), m) }
  check('CHECK: invalid handle rejected', errName(() => db.run("UPDATE accounts SET handle='a b', identity='unverified' WHERE id='a4'")).includes('constraint failed'))
  check('FK: deleting a profile nulls the link', (db.run("DELETE FROM browser_profiles WHERE id='bp2'"), db.get<{ p: unknown }>("SELECT browser_profile_id p FROM accounts WHERE id='a3'")?.p === null))
  check('cascade: account delete removes events', (db.run("INSERT INTO account_events VALUES ('e1','a4','created','x','x')"), db.run("DELETE FROM accounts WHERE id='a4'"), db.get<{ n: number }>('SELECT COUNT(*) n FROM account_events')?.n === 0))
  db.close()
}

// ── 2. AccountService behaviour on a fresh database ─────────────────────────
fresh(path)
const db = new SqliteDatabase(path).open()
check('fresh migrate → v16', migrate(db, log) === 16)
const profiles = new ProfileRepository(db)
const repo = new AccountRepository(db)
let listener: ((e: unknown[]) => void) | null = null
const pending = new Set<number>()
const opened: number[] = []
const ix = {
  onProfileEvents: (l: (e: unknown[]) => void) => ((listener = l), () => {}),
  setLinker: () => {},
  isPending: (id: number) => pending.has(id),
  openProfile: async (id: number) => (opened.push(id), { profile: profiles.getByExternalId(id)!, confirmed: true }),
  closeProfile: async (id: number) => ({ profile: profiles.getByExternalId(id)!, confirmed: true })
}
let changes = 0
const svc = new AccountService({ accounts: repo, profiles, ixBrowser: ix as never, log, onChange: () => changes++ })

db.exec("INSERT INTO provider_configs (id, kind, name, endpoint, created_at, updated_at) VALUES ('prov','ixbrowser','ix','http://127.0.0.1:53200','x','x')")
let n = 0
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
profiles.applySync(
  'prov',
  [1, 2, 3, 4].map((i) => ({ externalId: 200 + i, name: `Profile ${i}`, siteUrl: null, metadata: {}, contentHash: `h${i}` })),
  at,
  newId
)
const P = Object.fromEntries(profiles.list().map((p) => [p.externalId, p.id]))

const base = { handle: null, confirmIdentity: false, notes: '', enabled: true }
const a = svc.create({ ...base, label: '  Brand A ', profileId: P[201]! })
check('create trims label and links', a.label === 'Brand A' && a.profile?.externalId === 201 && a.identity === 'unknown' && a.handle === null)
check('create emits change', changes > 0)
check('details: created + linked events', svc.details(a.id).events.map((e) => e.kind).sort().join() === 'created,linked')

const b = svc.create({ ...base, label: 'Brand B', handle: '@brand_b', profileId: null })
check('handle without confirmation → unverified', b.handle === 'brand_b' && b.identity === 'unverified' && b.identityConfirmedAt === null)
check('duplicate profile association rejected', errName(() => svc.link(b.id, P[201]!)).startsWith('ConflictError'))
check('failed create-with-duplicate-profile rolls back', (() => {
  const before = svc.list().length
  const e = errName(() => svc.create({ ...base, label: 'X', profileId: P[201]! }))
  return e.startsWith('ConflictError') && svc.list().length === before
})())
check('duplicate handle rejected (case-insensitive)', errName(() => svc.create({ ...base, label: 'C', handle: 'BRAND_B', profileId: null })).startsWith('ConflictError'))
check('invalid handle rejected', errName(() => svc.create({ ...base, label: 'C', handle: 'has space', profileId: null })).startsWith('ValidationError'))
check('empty label rejected', errName(() => svc.create({ ...base, label: '   ', profileId: null })).startsWith('ValidationError'))

const b2 = svc.update(b.id, { label: 'Brand B2', handle: 'brand_b', confirmIdentity: true, notes: 'note', enabled: true })
check('confirm identity', b2.identity === 'confirmed' && b2.identityConfirmedAt !== null && b2.label === 'Brand B2' && b2.notes === 'note')
const b3 = svc.update(b.id, { label: 'Brand B2', handle: 'brand_bb', confirmIdentity: false, notes: 'note', enabled: true })
check('changing handle without confirm drops confirmation', b3.identity === 'unverified' && b3.identityConfirmedAt === null)
const b4 = svc.update(b.id, { label: 'Brand B2', handle: '', confirmIdentity: true, notes: 'note', enabled: true })
check('clearing handle → unknown even if confirm=true', b4.identity === 'unknown' && b4.handle === null)

check('link b to profile 202', svc.link(b.id, P[202]!).profile?.externalId === 202)
const relinked = svc.link(b.id, P[203]!)
check('re-link moves the association', relinked.profile?.externalId === 203 && repo.byProfile(P[202]!) === null)
check('re-link history', svc.details(b.id).events.filter((e) => e.kind === 'unlinked' || e.kind === 'linked').length === 3)
check('link to same profile is a no-op', svc.link(b.id, P[203]!).profile?.externalId === 203)
check('link to unknown profile → NotFound', errName(() => svc.link(b.id, '00000000-0000-4000-8000-999999999999')).startsWith('NotFoundError'))

// enable / disable
const dis = svc.setEnabled([a.id, b.id], false)
check('bulk disable', dis.changed === 2 && !svc.list().some((x) => x.enabled))
const dis2 = svc.setEnabled([a.id, 'missing-id'], false)
check('bulk disable skips already-disabled and missing', dis2.changed === 0 && dis2.skipped.length === 2)
check('disable event says local only', svc.details(a.id).events.some((e) => e.kind === 'disabled' && e.message.includes('local')))
svc.setEnabled([a.id, b.id], true)

// createFromProfiles
const cf = svc.createFromProfiles([P[201]!, P[204]!, P[204]!])
check('createFromProfiles skips linked, dedupes ids', cf.changed === 1 && cf.skipped.length === 1 && cf.accounts[0]?.label === 'Profile 4')
check('createFromProfiles never sets a username', cf.accounts[0]?.handle === null && cf.accounts[0]?.identity === 'unknown')

// sync changes: rename 201, drop 203 → events on linked accounts; profiles never deleted
const r2 = profiles.applySync(
  'prov',
  [
    { externalId: 201, name: 'Profile 1 renamed', siteUrl: null, metadata: {}, contentHash: 'h1b' },
    { externalId: 202, name: 'Profile 2', siteUrl: null, metadata: {}, contentHash: 'h2' },
    { externalId: 204, name: 'Profile 4', siteUrl: null, metadata: {}, contentHash: 'h4' }
  ],
  at,
  newId
)
check('applySync reports rename + unavailable', r2.changes.map((c) => c.kind).sort().join() === 'renamed,unavailable')
listener!(r2.changes)
check('rename recorded on linked account', svc.details(a.id).events.some((e) => e.kind === 'profile-renamed' && e.message.includes('renamed')))
check('linked account shows renamed profile', svc.list().find((x) => x.id === a.id)?.profile?.name === 'Profile 1 renamed')
const bNow = svc.list().find((x) => x.id === b.id)!
check('unavailable profile keeps link, reported unavailable', bNow.profile?.availability === 'unavailable' && svc.details(b.id).events.some((e) => e.kind === 'profile-unavailable'))
check('cannot link to unavailable profile', errName(() => svc.link(cf.accounts[0]!.id, P[203]!)).startsWith('ConflictError'))
check('createFromProfiles skips unavailable', svc.createFromProfiles([P[203]!]).skipped[0]?.reason.includes('No longer') === true)
const r3 = profiles.applySync('prov', [203, 201, 202, 204].map((i) => ({ externalId: i, name: i === 201 ? 'Profile 1 renamed' : `Profile ${i - 200}`, siteUrl: null, metadata: {}, contentHash: `h${i}` })), at, newId)
listener!(r3.changes)
check('restored profile recorded', svc.details(b.id).events.some((e) => e.kind === 'profile-restored'))

// open / close through the IX Browser service
await svc.openProfile(a.id).catch((e) => console.log("OPEN ERR", e.message, JSON.stringify(svc.list().find((x) => x.id === a.id))))
check('openProfile delegates with external id', opened.at(-1) === 201)
listener!([{ profileId: P[201]!, externalId: 201, kind: 'opened', confirmed: true }])
check('open recorded + last active touched', svc.details(a.id).events.some((e) => e.kind === 'profile-opened') && svc.list().find((x) => x.id === a.id)?.lastActiveAt !== null)
listener!([{ profileId: P[201]!, externalId: 201, kind: 'open-failed', message: 'IX said no' }])
check('failure recorded', svc.details(a.id).events.some((e) => e.kind === 'operation-failed' && e.message.includes('IX said no')))
const loose = svc.create({ ...base, label: 'Loose', profileId: null })
let openErr = ''
await svc.openProfile(loose.id).catch((e: Error) => (openErr = e.name))
check('openProfile on unlinked account → Conflict', openErr === 'ConflictError')

// unlink
pending.add(201)
const ul1 = svc.unlink([a.id])
check('unlink refused while open/close pending', ul1.changed === 0 && ul1.skipped[0]?.reason.includes('in progress') === true)
pending.clear()
const ul = svc.unlink([a.id, loose.id])
check('unlink keeps profile, skips unlinked', ul.changed === 1 && ul.skipped.length === 1 && profiles.get(P[201]!) !== null && svc.list().find((x) => x.id === a.id)?.profile === null)
check('profile free to link again after unlink', svc.link(loose.id, P[201]!).profile?.externalId === 201)

// remove
db.exec(`INSERT INTO drafts (id, body, account_id, status, origin, created_at, updated_at) VALUES ('d1','hi','${b.id}','draft','manual','${at}','${at}')`)
db.exec(`INSERT INTO scheduled_posts (id, draft_id, account_id, run_at, status, created_at, updated_at) VALUES ('s1','d1','${b.id}','${at}','pending','${at}','${at}')`)
const rm1 = svc.remove([b.id, a.id])
check('remove skips accounts with scheduled posts', rm1.changed === 1 && rm1.skipped[0]?.id === b.id)
check('removed account gone, events cascaded, profile kept', repo.get(a.id) === null && repo.events(a.id, 10).length === 0 && profiles.list().length === 4)
check('details references', svc.details(b.id).references.scheduled === 1 && svc.details(b.id).references.drafts === 1)
check('details of removed → NotFound', errName(() => svc.details(a.id)).startsWith('NotFoundError'))

// persistence across reopen
const countBefore = svc.list().length
db.close()
const db2 = new SqliteDatabase(path).open()
migrate(db2, log)
const repo2 = new AccountRepository(db2)
check('persisted after reopen', repo2.list().length === countBefore && repo2.get(b.id)?.label === 'Brand B2')
check('event prune', repo2.pruneEventsBefore('2999-01-01T00:00:00.000Z') > 0 && repo2.events(b.id, 10).length === 0)
db2.close()

console.log(results.join('\n'))
console.log(`\n${results.filter((x) => x.startsWith('FAIL')).length} failed of ${results.length}`)
