// Phase 11 unit tests: verified backup bundles, restore with safety backup and rollback.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseService } from '../../src/main/services/database/databaseService'
import { createSqliteRepositories } from '../../src/main/services/database/sqlite'
import { BackupService } from '../../src/main/services/backup/backupService'
import { readArchive, writeArchive } from '../../src/main/services/backup/archive'

const results: string[] = []
const check = (name: string, ok: boolean, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + String(extra).slice(0, 300) : ''}`)
const log = { debug() {}, info() {}, success() {}, warn() {}, error() {} }
const errOf = async (p: Promise<unknown>) => p.then(() => 'none', (e) => `${(e as Error).name}: ${(e as Error).message}`)

const root = process.argv[2]!
rmSync(root, { recursive: true, force: true })
const userData = join(root, 'user data')
const out = join(root, 'my backups')
const assetDir = join(userData, 'assets')
mkdirSync(join(assetDir, '2026-10'), { recursive: true })
mkdirSync(out, { recursive: true })

// ── archive round trip ──
const arch = join(root, 'a.tar.gz')
writeFileSync(join(root, 'big.bin'), Buffer.alloc(3 * 1024 * 1024 + 7, 7))
const written = await writeArchive(arch, [{ name: 'data/relay.db', path: join(root, 'big.bin') }, { name: 'assets/x/y.png', data: Buffer.from('png!') }], (f) => Buffer.from(JSON.stringify(f)))
const read = await readArchive(arch, () => null)
check('archive: round trip with checksums (incl. a multi-MB file, odd size)', read.length === 3 && written.every((w) => read.find((r) => r.name === w.name)?.sha256 === w.sha256))
check('archive: unsafe names refused', (await errOf(writeArchive(join(root, 'b.tar.gz'), [{ name: '../evil', data: Buffer.from('x') }]))).includes('Unsupported file name'))

// ── live data ──
const database = new DatabaseService(join(userData, 'data', 'relay.db'), log as never)
await database.open()
const db = database.db
const repos = createSqliteRepositories(db)
const at = new Date().toISOString()
db.exec(`INSERT INTO accounts (id, label, handle, identity, enabled, created_at, updated_at) VALUES ('a1','Brand','brand_x','unverified',1,'${at}','${at}')`)
for (const i of [1, 2, 3]) await repos.drafts.upsert({ id: `d${i}`, body: `Draft ${i}`, hashtags: [], sourceGenerationId: null, accountId: 'a1', status: 'draft', origin: 'manual', media: [], createdAt: at, updatedAt: at })
db.exec(`INSERT INTO image_assets (id, file_path, mime_type, origin, created_at, original_name, size_bytes) VALUES ('11111111-1111-4111-8111-111111111111','2026-10/one.png','image/png','upload','${at}','one.png',4)`)
writeFileSync(join(assetDir, '2026-10', 'one.png'), 'ORIG')
writeFileSync(join(assetDir, 'stray.tmp'), 'not referenced')
const settingsStore = repos.settings
settingsStore.set('backup.settings', { folder: out, schedule: 'off', keep: 2 })
const notices: string[] = []
let before = 0
let after = 0
const svc = new BackupService({
  database,
  settings: settingsStore,
  assetDir,
  recoveryDir: join(userData, 'backups'),
  workDir: join(userData, 'tmp'),
  notifier: { notify: (n: { title: string }) => (notices.push(n.title), true), clear() {} } as never,
  log: log as never,
  beforeRestore: async () => void before++,
  afterRestore: () => void after++
})

// ── create ──
const created = await svc.create()
const files = readdirSync(out)
check('backup created as one .axrbackup file, no partial left', created.status === 'created' && files.length === 1 && files[0]!.endsWith('.axrbackup') && !files.some((f) => f.endsWith('.partial')), files.join())
const bundle = join(out, files[0]!)
check('status records the verified result', svc.status().lastResult?.ok === true && svc.lastBackupAt() !== null)
const names = (await readArchive(bundle, () => null)).map((f) => f.name)
check('contains database, referenced images and manifest; no strays', names.includes('data/relay.db') && names.includes('assets/2026-10/one.png') && names.includes('manifest.json') && !names.some((n) => n.includes('stray')))
check('no work files left behind', !existsSync(join(userData, 'tmp')) || readdirSync(join(userData, 'tmp')).length === 0)

// ── concurrent operations ──
const first = svc.create()
check('a second backup while one runs is refused', (await errOf(svc.create())).includes('in progress'))
await first
rmSync(join(out, readdirSync(out).filter((f) => f !== files[0])[0]!))

// ── inspect ──
const insp = await svc.inspectPath(bundle)
check('inspect: valid bundle with counts', insp.status === 'valid' && insp.summary.format === 'bundle' && insp.summary.counts.drafts === 3 && insp.summary.images === 1 && insp.summary.counts.accounts === 1, JSON.stringify(insp))

// ── change data, then restore ──
await repos.drafts.remove('d1')
await repos.drafts.remove('d2')
await repos.drafts.upsert({ id: 'd9', body: 'After the backup', hashtags: [], sourceGenerationId: null, accountId: null, status: 'draft', origin: 'manual', media: [], createdAt: at, updatedAt: at })
writeFileSync(join(assetDir, '2026-10', 'one.png'), 'CHANGED')
writeFileSync(join(assetDir, '2026-10', 'new.png'), 'NEW')
await svc.restore((insp as { token: string }).token)
const ids = db.all<{ id: string }>('SELECT id FROM drafts ORDER BY id').map((r) => r.id).join()
check('restore: database back to the backup', ids === 'd1,d2,d3', ids)
check('restore: images back to the backup', readFileSync(join(assetDir, '2026-10', 'one.png'), 'utf8') === 'ORIG' && !existsSync(join(assetDir, '2026-10', 'new.png')))
check('restore: background work paused and resumed', before === 1 && after === 1)
const safety = readdirSync(join(userData, 'backups')).filter((f) => f.endsWith('.axrbackup'))
check('restore: safety backup of the previous state taken first', safety.length === 1 && safety[0]!.includes('-safety'))
const safetyInsp = await svc.inspectRecovery(safety[0]!)
check('safety backup holds the replaced data', safetyInsp.status === 'valid' && safetyInsp.summary.counts.drafts === 2)
check('restore notice', notices.includes('Restore completed'))
check('token used once', (await errOf(svc.restore((insp as { token: string }).token))).includes('expired'))

// ── damaged backups are refused ──
const workDirs = () => readdirSync(join(userData, 'tmp')).filter((n) => n.startsWith('restore-'))
const dirsBefore = workDirs().join()
const damaged = join(out, 'damaged.axrbackup')
const bytes = readFileSync(bundle)
const flipped = Buffer.from(bytes)
for (let i = 200; i < 260; i++) flipped[Math.floor(flipped.length / 2) + i] ^= 0xff
writeFileSync(damaged, flipped)
const d1 = await svc.inspectPath(damaged)
check('damaged bundle refused', d1.status === 'invalid', JSON.stringify(d1))
const truncated = join(out, 'truncated.axrbackup')
writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length * 0.6)))
const d2 = await svc.inspectPath(truncated)
check('truncated bundle refused', d2.status === 'invalid' && /damaged|incomplete/.test((d2 as { reason: string }).reason), JSON.stringify(d2))
const junk = join(out, 'junk.axrbackup')
writeFileSync(junk, 'hello')
check('non-backup refused', (await svc.inspectPath(junk)).status === 'invalid')
check('live database refused', (await svc.inspectPath(database.path)).status === 'invalid')
check('rejected backups leave no work folders behind', workDirs().join() === dirsBefore, workDirs().join())

// ── failed restore keeps current data ──
const beforeGood = new Set(workDirs())
const good = await svc.inspectPath(bundle)
await repos.drafts.upsert({ id: 'd7', body: 'Keep me', hashtags: [], sourceGenerationId: null, accountId: null, status: 'draft', origin: 'manual', media: [], createdAt: at, updatedAt: at })
writeFileSync(join(assetDir, '2026-10', 'keep.png'), 'KEEP')
const staging = workDirs().find((n) => !beforeGood.has(n))!
rmSync(join(userData, 'tmp', staging, 'data', 'relay.db'))
const failed = await errOf(svc.restore((good as { token: string }).token))
check('failed restore reported plainly', failed.includes('current data was kept'), failed)
check('… data unchanged', db.get<{ n: number }>("SELECT COUNT(*) AS n FROM drafts WHERE id = 'd7'")?.n === 1)
check('… images unchanged (put back)', readFileSync(join(assetDir, '2026-10', 'keep.png'), 'utf8') === 'KEEP')
check('… background work resumed', after === 2)

// ── legacy database-only backups still restore (images untouched) ──
const legacy = join(out, 'old.sqlite')
await database.backupTo(legacy)
await repos.drafts.remove('d7')
const li = await svc.inspectPath(legacy)
check('legacy .sqlite backup accepted as database-only', li.status === 'valid' && li.summary.format === 'database-only' && li.summary.includesImages === false)
await svc.restore((li as { token: string }).token)
check('legacy restore: database restored, images untouched', db.get<{ n: number }>("SELECT COUNT(*) AS n FROM drafts WHERE id = 'd7'")?.n === 1 && existsSync(join(assetDir, '2026-10', 'keep.png')))

// ── automatic backups ──
svc.updateSettings({ schedule: 'daily', keep: 2 })
const r1 = await svc.runAutoIfDue()
check('automatic backup runs when due', r1 && readdirSync(out).some((f) => f.endsWith('-auto.axrbackup')) && notices.includes('Backup completed successfully'))
check('… not again until the period passed', !(await svc.runAutoIfDue()))
for (const day of [2, 3]) {
  await new Promise((r) => setTimeout(r, 1100))
  await svc.runAutoIfDue(new Date(Date.now() + day * 86_400_000))
}
check('… only the newest N automatic backups kept', readdirSync(out).filter((f) => f.endsWith('-auto.axrbackup')).length === 2)
check('… manual backups are never pruned', readdirSync(out).some((f) => /backup-\d{4}-\d{2}-\d{2}-\d{6}\.axrbackup$/.test(f)))
check('settings validated', (await errOf(Promise.resolve().then(() => svc.updateSettings({ keep: 0 })))).includes('between 1 and 100'))
check('backup files are not huge (compressed)', statSync(bundle).size < 200_000, String(statSync(bundle).size))

database.close()
console.log(results.join('\n'))
console.log(`\n${results.filter((x) => x.startsWith('FAIL')).length} failed of ${results.length}`)
process.exit(0)
