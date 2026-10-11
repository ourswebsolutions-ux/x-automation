import { createServer } from 'node:http'
import { rmSync } from 'node:fs'
import { IxBrowserHttpClient, IxBrowserError, normalizeEndpoint } from '../../src/main/services/integrations/ixbrowser/client'
import { toProfileRecord } from '../../src/main/services/integrations/ixbrowser/schemas'
import { SqliteDatabase } from '../../src/main/services/database/driver'
import { migrate } from '../../src/main/services/database/migrator'
import { ProfileRepository } from '../../src/main/services/database/sqlite/profileRepository'

const results: string[] = []
const check = (name: string, ok: boolean, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
let mode = 'capped'
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const p = JSON.parse(body || '{}')
    const send = (o: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)) }
    if (mode === 'capped') {
      // Server ignores limit above 50
      const limit = Math.min(p.limit, 50)
      const all = Array.from({ length: 173 }, (_, i) => ({ profile_id: i + 1, name: 'P' + (i + 1) }))
      return send({ error: { code: 0 }, data: { total: 173, data: all.slice((p.page - 1) * limit, p.page * limit) } })
    }
    if (mode === 'endless') return send({ error: { code: 0 }, data: { total: 10 ** 9, data: [{ profile_id: p.page, name: 'x' }] } })
    if (mode === 'hang') return // never answers
    if (mode === 'message-only') return send({ error: { code: 7 } })
  })
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
const port = (server.address() as { port: number }).port
const client = new IxBrowserHttpClient({ endpoint: `http://127.0.0.1:${port}/api/v2/`, timeoutMs: 2000, retries: 0 })

check('normalizeEndpoint strips /api/v2 suffix', normalizeEndpoint('http://127.0.0.1:53200/api/v2/') === 'http://127.0.0.1:53200')
const capped = await client.listAllProfiles()
check('server capping limit → still complete', capped.length === 173 && new Set(capped.map((p) => p.profileId)).size === 173, String(capped.length))
mode = 'endless'
let err: IxBrowserError | null = null
try { await new IxBrowserHttpClient({ endpoint: `http://127.0.0.1:${port}`, timeoutMs: 2000, retries: 0 }).listAllProfiles() } catch (e) { err = e as IxBrowserError }
check('endless pagination guarded', err?.kind === 'malformed' && err.message.includes('Pagination'))
mode = 'hang'
const controller = new AbortController()
setTimeout(() => controller.abort(), 200)
const t0 = Date.now(); err = null
try { await client.ping(controller.signal) } catch (e) { err = e as IxBrowserError }
check('cancellation aborts in-flight request', err?.kind === 'cancelled' && Date.now() - t0 < 1500, `${err?.kind} ${Date.now() - t0}ms`)
mode = 'message-only'; err = null
try { await client.ping() } catch (e) { err = e as IxBrowserError }
check('error code without message', err?.kind === 'api' && err.code === 7 && err.message.includes('code 7'))
const rec = toProfileRecord({ profile_id: 3, name: '  ', site_url: '', api_key: 'x', session_id: 'y', otp_secret: 'z', email: 'e@x', nested: { a: 1 }, color: '#fff' })
check('record normalisation & sensitive filtering', rec?.name === 'Profile 3' && rec.siteUrl === null && Object.keys(rec.extra).join() === 'color', JSON.stringify(rec))
check('rejects non-integer / negative ids', toProfileRecord({ profile_id: 1.5 }) === null && toProfileRecord({ profile_id: -2 }) === null && toProfileRecord({ name: 'x' }) === null)
server.close()

const path = process.argv[2]!
for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true })
const db = new SqliteDatabase(path).open()
migrate(db, { debug() {}, info() {}, success() {}, warn() {}, error() {} })
const repo = new ProfileRepository(db)
db.run("INSERT INTO provider_configs (id, kind, name, endpoint, created_at, updated_at) VALUES ('px','ixbrowser','IX','http://127.0.0.1:1','t','t')")
let n = 0; const id = () => 'id' + n++
const at = '2026-01-01T00:00:00.000Z'
const r1 = repo.applySync('px', [{ externalId: 1, name: 'A', siteUrl: null, metadata: {}, contentHash: 'h1' }, { externalId: 2, name: 'B', siteUrl: null, metadata: { k: 1 }, contentHash: 'h2' }], at, id)
const r2 = repo.applySync('px', [{ externalId: 1, name: 'A2', siteUrl: null, metadata: {}, contentHash: 'h1b' }], at, id)
const r3 = repo.applySync('px', [{ externalId: 1, name: 'A2', siteUrl: null, metadata: {}, contentHash: 'h1b' }, { externalId: 2, name: 'B', siteUrl: null, metadata: {}, contentHash: 'h2' }], at, id)
check('applySync new/updated/unavailable/reappear', r1.added === 2 && r2.updated === 1 && r2.unavailable === 1 && r3.updated === 1 && r3.added === 0, JSON.stringify([r1, r2, r3]))
repo.applyRunState(new Set([1]), new Set([2]), at)
const list = repo.list()
check('run state api/client', list.find((p) => p.externalId === 1)?.openedBy === 'api' && list.find((p) => p.externalId === 2)?.openedBy === 'client')
repo.startRun('run1', 'px', at)
repo.finishRun({ id: 'run1', status: 'succeeded', finishedAt: at, discovered: 2, added: 0, updated: 1, unavailable: 0, duplicates: 0, error: null })
repo.startRun('run2', 'px', at)
check('stale run closed', repo.closeStaleRuns(at) === 1 && repo.runs(5).find((r) => r.id === 'run2')?.status === 'failed' && repo.lastSuccessfulRun()?.id === 'run1')
check('counts', JSON.stringify(repo.counts()) === JSON.stringify({ total: 2, available: 2, running: 2, unavailable: 0 }), JSON.stringify(repo.counts()))
db.close()
console.log(results.join('\n'))
console.log(`\n${results.filter((x) => x.startsWith('FAIL')).length} failed of ${results.length}`)
