import { rmSync } from 'node:fs'
import { SqliteDatabase, DatabaseError } from '../../src/main/services/database/driver'
import { migrate } from '../../src/main/services/database/migrator'
import { createSqliteRepositories } from '../../src/main/services/database/sqlite'
import { QueueRepository } from '../../src/main/services/database/sqlite/queueRepository'
import { ScheduleRepository } from '../../src/main/services/database/sqlite/scheduleRepository'
import { PostLinkRepository } from '../../src/main/services/database/sqlite/postLinkRepository'
import { redact, sanitizeMeta } from '../../src/main/services/logging/logger'

const results: string[] = []
const check = (name: string, ok: boolean, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
const log = { debug() {}, info() {}, success() {}, warn() {}, error() {} }
const path = process.argv[2]!
rmSync(path, { force: true }); rmSync(`${path}-wal`, { force: true }); rmSync(`${path}-shm`, { force: true })

const db = new SqliteDatabase(path).open()
check('migrate fresh → v12', migrate(db, log) === 12)
check('migrate is idempotent', migrate(db, log) === 12 && db.all('SELECT * FROM schema_migrations').length === 12)
const r = createSqliteRepositories(db)
const at = new Date().toISOString()

await (async () => {
  // accounts + browser profile FK
  db.run("INSERT INTO browser_profiles (id, external_id, name, synced_at) VALUES ('bp1','ext-1','Profile 1', :at)", { at })
  // Phase 4: accounts have their own repository (covered in accounts.test.ts); insert a row for the FK tests below.
  db.run("INSERT INTO accounts (id, label, handle, identity, browser_profile_id, linked_at, created_at, updated_at) VALUES ('a1','H One','h1','unverified','bp1', :at, :at, :at)", { at })
  check('accounts row with profile FK', db.get<{ n: number }>("SELECT COUNT(*) n FROM accounts WHERE browser_profile_id = 'bp1'")?.n === 1)

  // drafts + image assets
  await r.drafts.upsert({ id: 'd1', body: 'Hello', hashtags: [], sourceGenerationId: null, accountId: 'a1', status: 'draft', origin: 'manual', media: [], createdAt: at, updatedAt: at })
  db.run("INSERT INTO image_assets (id, draft_id, file_path, mime_type, origin, created_at) VALUES ('img1','d1','2026-01/x.png','image/png','upload', :at)", { at })
  // Phase 7: drafts reference images through draft_attachments.
  db.run("INSERT INTO draft_attachments (draft_id, asset_id, position, alt_text) VALUES ('d1','img1',0,'alt')")
  const d = await r.drafts.get('d1')
  check('drafts with media', d?.media.length === 1 && d.media[0]!.url === 'relay-asset://asset/img1' && d.media[0]!.altText === 'alt')

  // schedules + tasks + task_runs + post links (Phase 8 repositories)
  const schedules = new ScheduleRepository(db)
  const queue = new QueueRepository(db)
  const links = new PostLinkRepository(db)
  schedules.insert({ id: 's1', draftId: 'd1', accountId: 'a1', runAt: at, status: 'pending', remindedAt: null, createdAt: at, updatedAt: at })
  check('schedules insert', schedules.list({ view: 'upcoming' }).length === 1)
  for (const [id, n] of [['t1', 1], ['t2', 2], ['t3', 3]] as const) {
    queue.insert({ id, kind: 'publish', accountId: 'a1', draftId: 'd1', scheduleId: null, label: id, payload: {}, idempotencyKey: null, maxAttempts: 3, runAfter: at, createdAt: new Date(Date.now() + n * 1000).toISOString() })
  }
  check('claim is exclusive', queue.claim('t2', at) && !queue.claim('t2', at))
  queue.finish('t3', { status: 'failed', errorCode: 'X', error: 'x', result: null }, new Date(Date.now() + 9000).toISOString())
  const counts = queue.counts()
  check('task counts by status', counts.queued === 1 && counts.running === 1 && counts.failed === 1, JSON.stringify(counts))
  check('tasks recent ordering', queue.recent(2).map((t) => t.id)[0] === 't3')
  db.run("INSERT INTO task_runs (id, task_id, attempt, status, started_at) VALUES ('run1','t1',1,'running', :at)", { at })
  links.insert({ id: 'p1', url: 'https://x.com/h1/status/1', postId: '1', handle: 'h1', accountId: 'a1', draftId: 'd1', taskId: 't1', source: 'published', preview: 'Hello', publishedAt: at, createdAt: at })
  check('post links insert', links.count() === 1)

  // FK behaviour
  await r.drafts.remove('d1')
  check('FK: draft delete cascades schedules', schedules.list({ view: 'all' }).length === 0)
  check('FK: draft delete nulls task + link draft_id', queue.get('t1')?.draftId === null && links.get('p1')?.draftId === null)
  check('FK: draft delete nulls image draft_id', db.get<{ draft_id: string | null }>("SELECT draft_id FROM image_assets WHERE id='img1'")?.draft_id === null)
  db.run("DELETE FROM tasks WHERE id = 't1'")
  check('FK: task delete cascades runs, keeps the link', (db.get<{ n: number }>('SELECT COUNT(*) n FROM task_runs')?.n ?? -1) === 0 && links.get('p1')?.taskId === null)
  let fkError = ''
  try { schedules.insert({ id: 's2', draftId: 'missing', accountId: 'a1', runAt: at, status: 'pending', remindedAt: null, createdAt: at, updatedAt: at }) } catch (e) { fkError = (e as DatabaseError).code }
  check('FK violation → CONSTRAINT error', fkError === 'CONSTRAINT', fkError)

  // activity + prune
  await r.activity.append({ id: 'ev1', level: 'info', message: 'old', subject: null, at: '2000-01-01T00:00:00.000Z' })
  await r.activity.append({ id: 'ev2', level: 'success', message: 'new', subject: 's', at })
  check('activity prune', r.activity.pruneBefore('2020-01-01T00:00:00.000Z') === 1 && (await r.activity.recent(10)).length === 1)

  // settings with LIKE-special characters in prefix
  r.settings.setMany({ 'pref.theme': 'dark', 'pref.x': { a: 1 }, 'prefXtheme': 'nope', 'pref_y': 1 })
  const prefs = r.settings.entries('pref.')
  check('settings prefix escaping', Object.keys(prefs).sort().join() === 'theme,x' && (prefs.x as { a: number }).a === 1, JSON.stringify(prefs))
  r.settings.delete('pref.x')
  check('settings delete', r.settings.get('pref.x') === undefined && r.settings.get('pref.theme') === 'dark')

  // notification preferences
  r.notificationPreferences.save({ taskFailures: { inApp: true, desktop: false }, scheduleReminders: { inApp: false, desktop: true }, systemNotices: { inApp: true, desktop: true } })
  const np = r.notificationPreferences.all()
  check('notification prefs round-trip', np.scheduleReminders?.inApp === false && np.scheduleReminders.desktop === true)

  // providers + credential refs cascade
  r.providers.insert({ id: 'pr1', kind: 'openai-compatible', name: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: 'm', enabled: true, settings: { timeoutMs: 5000, retries: 2 }, createdAt: at, updatedAt: at })
  r.providers.update({ id: 'pr1', kind: 'openai-compatible', name: 'OpenAI 2', endpoint: 'https://api.openai.com/v1', model: null, enabled: false, settings: { timeoutMs: 7000, retries: 0 }, createdAt: at, updatedAt: at })
  const pr = r.providers.get('pr1')
  check('providers insert/update (+settings)', pr?.name === 'OpenAI 2' && pr.model === null && pr.enabled === false && pr.settings.timeoutMs === 7000 && pr.settings.retries === 0)
  let dupCode = ''
  try { r.providers.insert({ id: 'pr2', kind: 'openai-compatible', name: 'openai 2', endpoint: 'https://a.b', model: null, enabled: true, settings: { timeoutMs: 5000, retries: 2 }, createdAt: at, updatedAt: at }) } catch (e) { dupCode = (e as DatabaseError).code }
  check('unique provider name (case-insensitive) enforced by DB', dupCode === 'CONSTRAINT')
  r.credentialRefs.upsert({ id: 'c1', providerId: 'pr1', vaultKey: 'provider:pr1', hint: 'abcd', createdAt: at, updatedAt: at })
  r.credentialRefs.upsert({ id: 'c1-ignored', providerId: 'pr1', vaultKey: 'provider:pr1', hint: 'wxyz', createdAt: at, updatedAt: at })
  check('credential ref upsert by provider', r.credentialRefs.all().length === 1 && r.credentialRefs.forProvider('pr1')?.hint === 'wxyz')
  r.providers.remove('pr1')
  check('provider delete cascades credential ref', r.credentialRefs.all().length === 0)

  // logs: filters, LIKE escaping, prune, clear
  r.logs.insert({ at: '2000-01-01T00:00:00.000Z', level: 'info', scope: 'old', message: 'ancient', meta: null })
  r.logs.insert({ at, level: 'warning', scope: 'db', message: '100% done_ok', meta: { n: 1 } })
  r.logs.insert({ at, level: 'error', scope: 'db', message: '100 percent', meta: null })
  check('logs level filter', r.logs.query({ levels: ['warning'] }).length === 1)
  check('logs search escapes % and _', r.logs.query({ search: '100%' }).length === 1 && r.logs.query({ search: 'done_ok' }).length === 1 && r.logs.query({ search: '_' }).length === 1)
  check('logs meta round-trip', r.logs.query({ levels: ['warning'] })[0]?.meta?.n === 1)
  check('logs prune', r.logs.pruneBefore('2020-01-01T00:00:00.000Z') === 1)
  check('logs clear', r.logs.clear() === 2 && r.logs.query({}).length === 0)

  // transactions
  try { db.transaction(() => { r.settings.set('tx.a', 1); throw new Error('boom') }) } catch {}
  check('transaction rollback', r.settings.get('tx.a') === undefined)
  db.transaction(() => {
    r.settings.set('tx.outer', 1)
    try { db.transaction(() => { r.settings.set('tx.inner', 1); throw new Error('inner') }) } catch {}
  })
  check('nested savepoint rollback keeps outer', r.settings.get('tx.outer') === 1 && r.settings.get('tx.inner') === undefined)

  // parameter strictness (catches mismatched SQL/params)
  let strict = ''
  try { db.run('SELECT :a', { a: 1, b: 2 }) } catch (e) { strict = (e as Error).message }
  check('unknown named parameters rejected', strict.includes('Unknown named parameter'))
})()

db.close()

// version / foreign file guards
const newer = new SqliteDatabase(path).open(); newer.exec('PRAGMA user_version = 99')
let code = ''
try { migrate(newer, log) } catch (e) { code = (e as DatabaseError).code }
check('newer schema refused (INCOMPATIBLE)', code === 'INCOMPATIBLE'); newer.close()
const foreignPath = `${path}.foreign`; rmSync(foreignPath, { force: true })
const foreign = new SqliteDatabase(foreignPath).open(); foreign.exec('PRAGMA application_id = 1234')
code = ''
try { migrate(foreign, log) } catch (e) { code = (e as DatabaseError).code }
check('foreign application_id refused', code === 'INCOMPATIBLE'); foreign.close()

// redaction helpers
check('redact OpenAI key', !redact('key sk-abcdefghijklmnop1234 end').includes('abcdefghijklmnop'))
check('redact JWT', redact('t eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c').includes('[redacted]'))
const meta = sanitizeMeta({ apiKey: 'abc', sessionCookie: 'x', count: 3, note: 'password=hunter22', nested: { a: 1 } })
check('sanitizeMeta drops sensitive keys & non-primitives', meta?.apiKey === '[redacted]' && meta.sessionCookie === '[redacted]' && meta.count === 3 && !String(meta.note).includes('hunter22') && !('nested' in (meta ?? {})))

console.log(results.join('\n'))
console.log(`\n${results.filter((x) => x.startsWith('FAIL')).length} failed of ${results.length}`)
