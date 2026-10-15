import { createServer, connect, type Server, type Socket } from 'node:net'
import { rmSync } from 'node:fs'
import { parseProxyCsv, parseProxyLine, toCsv, toTxt } from '../../src/main/services/proxies/proxyFormat'
import { testProxy } from '../../src/main/services/proxies/proxyTester'
import { ProxyService } from '../../src/main/services/proxies/proxyService'
import { ProxyRepository } from '../../src/main/services/database/sqlite/proxyRepository'
import { ProfileRepository } from '../../src/main/services/database/sqlite/profileRepository'
import { SqliteDatabase } from '../../src/main/services/database/driver'
import { migrate } from '../../src/main/services/database/migrator'

const results: string[] = []
const check = (name: string, ok: boolean, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
const logged: string[] = []
const log = { debug() {}, info: (m: string, meta?: unknown) => logged.push(m + JSON.stringify(meta ?? {})), success: (m: string) => logged.push(m), warn: (m: string) => logged.push(m), error: (m: string) => logged.push(m) }
const errOf = async (p: Promise<unknown>) => p.then(() => 'none', (e) => `${(e as Error).name}: ${(e as Error).message}`)

// ── parsing ──
const ok = (line: string, exp: Record<string, unknown>) => {
  const r = parseProxyLine(line)
  return typeof r !== 'string' && Object.entries(exp).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v)
}
check('host:port', ok('1.2.3.4:8080', { host: '1.2.3.4', port: 8080, username: null, scheme: 'http' }))
check('host:port:user:pass', ok('proxy.example.com:3128:alice:s3cr:et', { host: 'proxy.example.com', port: 3128, username: 'alice', password: 's3cr:et' }))
check('user:pass@host:port', ok('alice:pw@10.0.0.1:1080', { host: '10.0.0.1', port: 1080, username: 'alice', password: 'pw' }))
check('host:port@user:pass', ok('10.0.0.1:1080@alice:pw', { host: '10.0.0.1', username: 'alice', password: 'pw' }))
check('user:pass:host:port', ok('alice:pw:proxy.example.com:9000', { host: 'proxy.example.com', port: 9000, username: 'alice' }))
check('scheme URL with encoded creds', ok('socks5://al%40ce:p%3Aw@[2001:db8::1]:1080', { scheme: 'socks5', host: '2001:db8::1', port: 1080, username: 'al@ce', password: 'p:w' }))
check('rejections', ['', 'just-a-host', '1.2.3.4:99999', 'ftp://1.2.3.4:21', 'bad host:80'].every((l) => typeof parseProxyLine(l) === 'string'))
const csv = parseProxyCsv('label,type,host,port,username,password,notes\n"Office, main",socks5,10.1.1.1,1080,bob,"p""w",note\nX,ftp,1.1.1.1,21,,,\nY,http,2.2.2.2,0,,,')
check('CSV with quotes, bad type, bad port', csv.length === 3 && typeof csv[0]!.result !== 'string' && (csv[0]!.result as { label: string; password: string }).label === 'Office, main' && (csv[0]!.result as { password: string }).password === 'p"w' && typeof csv[1]!.result === 'string' && typeof csv[2]!.result === 'string' && csv[2]!.line === 4)
check('CSV export never contains passwords', !toCsv([{ label: 'a', scheme: 'http', host: 'h', port: 1, username: 'u', notes: '' }]).includes('password') && toTxt([{ scheme: 'socks5', host: '::1', port: 9, username: 'u@x' }]) === 'socks5://u%40x@[::1]:9')

// ── real local proxies ──
const listen = (server: Server) => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)))
const target = createServer((s) => s.on('data', (d) => s.write(d)))
const targetPort = await listen(target)
const pipe = (a: Socket, port: number, onReady: () => void) => {
  const b = connect(port, '127.0.0.1', onReady)
  a.pipe(b).pipe(a)
  b.on('error', () => a.destroy())
  a.on('error', () => b.destroy())
}
// HTTP CONNECT proxy requiring alice:pw
const http = createServer((s) => {
  s.once('data', (d) => {
    const head = d.toString('latin1')
    const m = /^CONNECT ([^:]+):(\d+) HTTP/.exec(head)
    if (!m) return s.end('HTTP/1.1 400 Bad\r\n\r\n')
    if (!head.includes(`Proxy-Authorization: Basic ${Buffer.from('alice:pw').toString('base64')}`)) return s.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
    pipe(s, Number(m[2]), () => s.write('HTTP/1.1 200 Connection established\r\n\r\n'))
  })
})
const httpPort = await listen(http)
// SOCKS5 proxy requiring bob:pw2
const socks = createServer((s) => {
  let stage = 0
  s.on('data', function onData(d) {
    if (stage === 0) {
      stage = d.includes(2) ? 1 : 9
      s.write(Buffer.from([5, d.includes(2) ? 2 : 0xff]))
    } else if (stage === 1) {
      const ulen = d[1]!
      const user = d.subarray(2, 2 + ulen).toString()
      const pass = d.subarray(3 + ulen, 3 + ulen + d[2 + ulen]!).toString()
      const good = user === 'bob' && pass === 'pw2'
      s.write(Buffer.from([1, good ? 0 : 1]))
      stage = good ? 2 : 9
    } else if (stage === 2) {
      s.off('data', onData)
      const port = d.readUInt16BE(d.length - 2)
      pipe(s, port, () => s.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])))
    }
  })
})
const socksPort = await listen(socks)
const tgt = { host: '127.0.0.1', port: targetPort, tls: false }

const h1 = await testProxy({ scheme: 'http', host: '127.0.0.1', port: httpPort, username: 'alice', password: 'pw' }, tgt)
check('HTTP CONNECT with auth: tunnel verified + latency', h1.ok && h1.verified === 'tunnel' && typeof h1.latencyMs === 'number', JSON.stringify(h1))
const h2 = await testProxy({ scheme: 'http', host: '127.0.0.1', port: httpPort, username: 'alice', password: 'wrong' }, tgt)
check('HTTP wrong password → 407 explained, password not echoed', !h2.ok && h2.error!.includes('407') && !h2.error!.includes('wrong'))
const h3 = await testProxy({ scheme: 'http', host: '127.0.0.1', port: httpPort, username: null, password: null }, tgt)
check('HTTP no credentials → requires auth', !h3.ok && h3.error!.includes('requires a username'))
const s1 = await testProxy({ scheme: 'socks5', host: '127.0.0.1', port: socksPort, username: 'bob', password: 'pw2' }, tgt)
check('SOCKS5 with user/pass auth (RFC 1929): tunnel verified', s1.ok && s1.verified === 'tunnel', JSON.stringify(s1))
const s2 = await testProxy({ scheme: 'socks5', host: '127.0.0.1', port: socksPort, username: 'bob', password: 'nope' }, tgt)
check('SOCKS5 wrong password → rejected', !s2.ok && s2.error!.includes('rejected the username or password'))
const s3 = await testProxy({ scheme: 'socks5', host: '127.0.0.1', port: socksPort, username: null, password: null }, tgt)
check('SOCKS5 without credentials → explained', !s3.ok && /requires a username|none of the offered/.test(s3.error!))
const wrongType = await testProxy({ scheme: 'socks5', host: '127.0.0.1', port: httpPort, username: 'x', password: 'y' }, tgt, 3000)
check('wrong type (SOCKS to an HTTP proxy) → explained', !wrongType.ok && wrongType.error !== null, wrongType.error ?? '')
const refused = await testProxy({ scheme: 'http', host: '127.0.0.1', port: 9, username: null, password: null }, tgt)
check('nothing listening → ECONNREFUSED explained', !refused.ok && refused.error!.includes('Nothing is accepting'))
const silent = createServer(() => undefined)
const silentPort = await listen(silent)
const t0 = Date.now()
const timeout = await testProxy({ scheme: 'http', host: '127.0.0.1', port: silentPort, username: null, password: null }, tgt, 1500)
check('silent proxy → timeout after limit', !timeout.ok && timeout.error!.includes('No answer') && Date.now() - t0 < 4000)

// ── service with a real DB, vault stub and IX stub ──
const path = process.argv[2]!
for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true })
const db = new SqliteDatabase(path).open()
check('migrate → v16', migrate(db, log) === 16)
db.exec("INSERT INTO provider_configs (id, kind, name, endpoint, created_at, updated_at) VALUES ('prov','ixbrowser','ix','http://127.0.0.1:53200','x','x')")
const profiles = new ProfileRepository(db)
let n = 0
profiles.applySync('prov', [1, 2, 3].map((i) => ({ externalId: i, name: `P${i}`, siteUrl: null, metadata: {}, contentHash: `h${i}` })), 'x', () => `00000000-0000-4000-8000-00000000000${++n}`)
db.exec("UPDATE browser_profiles SET run_state = 'running' WHERE external_id = '3'")
const vaultStore = new Map<string, string>()
const vault = { status: () => ({ available: true, secure: true, backend: 't', detail: '' }), has: (k: string) => vaultStore.has(k), set: async (k: string, v: string) => void vaultStore.set(k, v), get: (k: string) => vaultStore.get(k) ?? null, delete: async (k: string) => void vaultStore.delete(k), keys: () => [...vaultStore.keys()], clear: async () => 0 }
const settingsStore = new Map<string, unknown>()
const settings = { get: (k: string) => settingsStore.get(k), set: (k: string, v: unknown) => void settingsStore.set(k, v), setMany() {}, entries: () => ({}), delete: (k: string) => void settingsStore.delete(k) }
const applied: { externalId: number; proxy: Record<string, unknown> }[] = []
let ixFail: string | null = null
const ixBrowser = {
  applyCustomProxy: async (externalId: number, proxy: Record<string, unknown>) => {
    const p = profiles.getByExternalId(externalId)!
    if (p.runState === 'running') throw new Error('This profile is open, so the proxy was not applied. — Close it first.')
    if (ixFail) throw new Error(ixFail)
    applied.push({ externalId, proxy })
  }
}
let changed = 0
const svc = new ProxyService({ repo: new ProxyRepository(db), vault: vault as never, settings: settings as never, profiles, ixBrowser: ixBrowser as never, log, onChange: () => changed++, testTarget: tgt })

const p1 = await svc.create({ label: 'Local HTTP', scheme: 'http', host: '127.0.0.1', port: httpPort, username: 'alice', password: 'pw', enabled: true, notes: '' })
check('create: password in vault only', p1.hasPassword && vaultStore.get(`proxy:${p1.id}`) === 'pw' && !JSON.stringify(db.all('SELECT * FROM proxies')).includes('"pw"') && !JSON.stringify(p1).includes('"pw"'))
check('duplicate rejected', (await errOf(svc.create({ label: 'dup', scheme: 'http', host: '127.0.0.1', port: httpPort, username: 'alice', password: null, enabled: true, notes: '' }))).startsWith('ConflictError'))
check('validation: bad host/port', (await errOf(svc.create({ label: '', scheme: 'http', host: 'bad host', port: 1, username: null, enabled: true, notes: '' }))).startsWith('ValidationError') && (await errOf(svc.create({ label: '', scheme: 'http', host: 'h.com', port: 70000, username: null, enabled: true, notes: '' }))).startsWith('ValidationError'))
const t1 = await svc.test(p1.id)
check('service test uses vault password, saves result', t1.ok && svc.get(p1.id).lastTest?.ok === true)
const p1b = await svc.update(p1.id, { label: 'Local HTTP', scheme: 'http', host: '127.0.0.1', port: httpPort, username: 'alice', password: 'wrong', enabled: true, notes: '' })
check('password change clears old test result', p1b.lastTest === null && vaultStore.get(`proxy:${p1.id}`) === 'wrong')
check('re-test reports the failure', (await svc.test(p1.id)).ok === false)
await svc.update(p1.id, { label: 'Local HTTP', scheme: 'http', host: '127.0.0.1', port: httpPort, username: 'alice', password: 'pw', enabled: true, notes: 'kept' })
check('label/notes edit keeps password (undefined = keep)', (await svc.update(p1.id, { label: 'Renamed', scheme: 'http', host: '127.0.0.1', port: httpPort, username: 'alice', enabled: true, notes: 'n' })).hasPassword && vaultStore.has(`proxy:${p1.id}`))

const imp = await svc.import('# comment\n1.2.3.4:8080\nsocks5://u:p@5.6.7.8:1080\n1.2.3.4:8080\nbad line\n9.9.9.9:3128:user:pass', 'txt')
check('TXT import: added, duplicates, rejected with line numbers', imp.added === 3 && imp.duplicates === 1 && imp.rejected.length === 1 && imp.rejected[0]!.line === 5, JSON.stringify(imp))
const imp2 = await svc.import('label,type,host,port,username,password\nCSV one,https,secure.example.com,443,carol,cpw', 'csv')
check('CSV import with password into vault', imp2.added === 1 && [...vaultStore.values()].includes('cpw'))
const exp = svc.export('csv')
check('export: all rows, no passwords', exp.count === 5 && !/pw|cpw|"p"/.test(exp.text.split('\n').slice(1).join('\n').replace(/carol|alice/g, '')) && !exp.text.includes('cpw'))

const [prof1, prof2, prof3] = profiles.list().sort((a, b) => a.externalId - b.externalId)
const a1 = await svc.assign([prof1!.id, prof2!.id, prof3!.id], p1.id)
check('assign: closed profiles applied, open profile refused with reason', a1.changed === 2 && a1.skipped.length === 1 && a1.skipped[0]!.reason.includes('open'))
check('IX received the decrypted password for the proxy', applied.length === 2 && applied[0]!.proxy.password === 'pw' && applied[0]!.proxy.scheme === 'http')
check('assignment rows recorded as applied', svc.assignments().filter((a) => a.status === 'applied').length === 2 && !svc.assignments().some((a) => a.profileId === prof3!.id))
check('assigned proxy cannot be deleted', (await errOf(svc.remove(p1.id))).includes('assigned to 2 profiles'))
ixFail = 'IX Browser reported an error (code 1001): profile locked'
const other = svc.list().find((p) => p.host === '5.6.7.8')!
const a2 = await svc.assign([prof1!.id], other.id)
check('IX refusal recorded as failed with its message', a2.changed === 0 && svc.assignments().find((a) => a.profileId === prof1!.id)?.status === 'failed')
ixFail = null
check('explicit retry succeeds', (await svc.assign([prof1!.id], other.id)).changed === 1 && svc.assignments().find((a) => a.profileId === prof1!.id)?.status === 'applied')
check('disabled proxy cannot be assigned', (await errOf(svc.assign([prof1!.id], (await svc.update(other.id, { label: other.label, scheme: other.scheme, host: other.host, port: other.port, username: other.username, enabled: false, notes: '' })).id))).startsWith('ValidationError'))
const appliedBefore = applied.length
check('unassign is local only (no IX call)', svc.unassign([prof2!.id]).changed === 1 && applied.length === appliedBefore)
svc.setDefault(p1.id)
check('default flag', svc.list().find((p) => p.id === p1.id)?.isDefault === true)
const ad = await svc.applyDefault()
check('apply default to unassigned available profiles (open one refused)', ad.changed === 1 && ad.skipped.length === 1, JSON.stringify(ad))
svc.unassign([prof1!.id, prof2!.id])
await svc.remove(p1.id)
check('delete proxy removes vault entry and clears default', !vaultStore.has(`proxy:${p1.id}`) && !settingsStore.has('proxy.defaultId'))
check('logs never contain proxy passwords', !logged.some((l) => /"pw"|cpw|wrong|pass\b/.test(l)), logged.find((l) => /pw/.test(l)) ?? '')

db.close()
for (const s of [target, http, socks, silent]) s.close()
console.log(results.join('\n'))
console.log(`\n${results.filter((x) => x.startsWith('FAIL')).length} failed of ${results.length}`)
process.exit(0)
