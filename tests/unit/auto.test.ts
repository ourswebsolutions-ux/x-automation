// Phases 10 + 11 unit tests: queue pause/resume/stop/hold, usage report, rates, limits.
import { rmSync } from 'node:fs'
import { SqliteDatabase } from '../../src/main/services/database/driver'
import { migrate } from '../../src/main/services/database/migrator'
import { createSqliteRepositories } from '../../src/main/services/database/sqlite'
import { QueueRepository } from '../../src/main/services/database/sqlite/queueRepository'
import { QueueService } from '../../src/main/services/queue/queueService'
import { TaskError } from '../../src/main/services/queue/types'
import { UsageService } from '../../src/main/services/usage/usageService'
import { retryDelayMs } from '../../src/shared/types/publishing'

const results: string[] = []
const check = (name: string, ok: boolean, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + String(extra).slice(0, 300) : ''}`)
const log = { debug() {}, info() {}, success() {}, warn() {}, error() {} }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (fn: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(20) } return false }
const errOf = (fn: () => unknown) => { try { fn(); return 'none' } catch (e) { return (e as Error).message } }

const file = process.argv[2]!
rmSync(file, { force: true })
const db = new SqliteDatabase(file).open()
check('migrate → v13', migrate(db, log as never) === 13)
const repos = createSqliteRepositories(db)
const at = new Date().toISOString()
db.exec(`INSERT INTO accounts (id, label, handle, identity, enabled, created_at, updated_at) VALUES ('a1','A',NULL,'unknown',1,'${at}','${at}'),('a2','B',NULL,'unknown',1,'${at}','${at}')`)

// ── queue controls (with a controllable fake handler) ──
const repo = new QueueRepository(db)
const runs: string[] = []
let gate: (() => void) | null = null
const handler = {
  kind: 'sync-profiles' as const,
  idempotent: true,
  async run(task: { id: string; label: string }, ctx: { signal: AbortSignal }) {
    runs.push(task.label)
    if (task.label.startsWith('slow')) {
      await new Promise<void>((r) => { gate = r; ctx.signal.addEventListener('abort', () => r(), { once: true }) })
      if (ctx.signal.aborted) throw new TaskError('CANCELLED', 'Stopped.', 'retry')
    }
    return null
  }
}
const q = new QueueService({ repo, settings: repos.settings, log: log as never, onChange() {} })
q.register(handler as never)
q.pause()
q.start()
const t1 = q.enqueue({ kind: 'sync-profiles', accountId: 'a1', draftId: null, scheduleId: null, label: 'one', payload: {}, idempotencyKey: null })
await sleep(150)
check('paused queue starts nothing', runs.length === 0 && repo.get(t1.id)!.status === 'queued')
check('paused state is persisted', (repos.settings.get('automation.paused') as { at?: string } | undefined)?.at !== undefined)
const q2 = new QueueService({ repo, settings: repos.settings, log: log as never, onChange() {} })
check('… and survives a restart', q2.paused)
q.resume()
check('resume runs waiting tasks', await waitFor(() => repo.get(t1.id)!.status === 'succeeded'))

const held = q.enqueue({ kind: 'sync-profiles', accountId: 'a2', draftId: null, scheduleId: null, label: 'held', payload: {}, idempotencyKey: null })
q.pause()
q.setHeld(held.id, true)
q.resume()
await sleep(150)
check('held task stays queued while others run', repo.get(held.id)!.status === 'queued' && repo.get(held.id)!.held && q.counts().held === 1)
q.setHeld(held.id, false)
check('released task runs', await waitFor(() => repo.get(held.id)!.status === 'succeeded'))
check('only waiting tasks can be held', errOf(() => q.setHeld(held.id, true)).includes('Only waiting tasks'))

const slow = q.enqueue({ kind: 'sync-profiles', accountId: 'a1', draftId: null, scheduleId: null, label: 'slow', payload: {}, idempotencyKey: null })
await waitFor(() => repo.get(slow.id)!.status === 'running')
check('current task reported', q.current()?.id === slow.id)
q.stopNow()
check('stop now: paused, running task put back in the queue (not cancelled)', await waitFor(() => repo.get(slow.id)!.status === 'queued') && q.paused)
check('… the interrupted attempt does not count', repo.get(slow.id)!.attempts === 0)
q.resume()
await waitFor(() => repo.get(slow.id)!.status === 'running')
gate?.()
check('… and it runs again after resume', await waitFor(() => repo.get(slow.id)!.status === 'succeeded'))
const today = new Date()
const counts = q.finishedBetween(new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString(), new Date(Date.now() + 86_400_000).toISOString())
check('today’s finished count', counts.succeeded === 3)
await q.stop()
check('retry delay grows ×5, capped at an hour', retryDelayMs({ retryDelayMinutes: 2 }, 1) === 120_000 && retryDelayMs({ retryDelayMinutes: 2 }, 2) === 600_000 && retryDelayMs({ retryDelayMinutes: 2 }, 3) === 3_000_000 && retryDelayMs({ retryDelayMinutes: 2 }, 4) === 3_600_000)

// ── usage ──
db.exec(`INSERT INTO provider_configs (id, kind, adapter, name, endpoint, model, enabled, settings, created_at, updated_at) VALUES
  ('p1','openai-compatible','openai','OpenAI','https://api.openai.com/v1','gpt-x',1,'{}','${at}','${at}'),
  ('p2','image','openai-images','Images','https://api.openai.com/v1','img-1',1,'{}','${at}','${at}')`)
const ins = (id: string, provider: string, op: string, status: string, startedAt: string, inTok: number | null, outTok: number | null, images: number | null, model = 'gpt-x') =>
  db.run(`INSERT INTO ai_usage (id, provider_id, provider_name, adapter, model, operation, status, started_at, input_tokens, output_tokens, total_tokens, usage_reported, image_count)
    VALUES (:id, :provider, :name, 'openai', :model, :op, :status, :startedAt, :inTok, :outTok, :total, :reported, :images)`, {
    id, provider, name: provider === 'p1' ? 'OpenAI' : 'Images', model, op, status, startedAt, inTok, outTok, total: inTok === null ? null : (inTok ?? 0) + (outTok ?? 0), reported: inTok === null ? 0 : 1, images
  })
const now = new Date()
// Today's records sit in the first minutes after midnight, so they are always "today so far" whatever time the suite runs.
const iso = (daysAgo: number, h = 12, m = 0) => { const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, h, m); return d.toISOString() }
ins('u1', 'p1', 'generate-text', 'succeeded', iso(0, 0, 1), 1000, 500, null)
ins('u2', 'p1', 'generate-text', 'succeeded', iso(0, 0, 2), 2000, 1000, null)
ins('u3', 'p1', 'generate-text', 'failed', iso(0, 0, 3), null, null, null)
ins('u4', 'p1', 'generate-text', 'succeeded', iso(1), null, null, null)
ins('u5', 'p2', 'generate-image', 'succeeded', iso(1), null, null, 2, 'img-1')
ins('u6', 'p1', 'connection-test', 'succeeded', iso(2), null, null, null)
const notices: { title: string; body?: string }[] = []
const usage = new UsageService({ db, notifier: { notify: (n: { title: string; body?: string }) => (notices.push(n), true) } as never, log: log as never, onChange() {} })
const range = { from: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).toISOString(), to: new Date(Date.now() + 60_000).toISOString() }
let r = usage.report(range)
check('totals: requests, outcomes, reported tokens and images exactly', r.totals.requests === 6 && r.totals.succeeded === 5 && r.totals.failed === 1 && r.totals.inputTokens === 3000 && r.totals.outputTokens === 1500 && r.totals.images === 2 && r.totals.withReportedUsage === 2, JSON.stringify(r.totals))
check('no rates → no cost shown (null, not zero)', r.totals.estimatedCost === null && r.totals.priced === 0 && r.totals.unpriced === 5)
check('grouped by day, provider and request type', r.byDay.length === 3 && r.byProvider.length === 2 && r.byOperation.find((o) => o.key === 'generate-text')?.requests === 4)
usage.saveRate({ providerId: 'p1', model: null, inputPerMillion: 2, outputPerMillion: 8, perImage: null, note: 'from my invoice' })
usage.saveRate({ providerId: 'p2', model: 'img-1', inputPerMillion: null, outputPerMillion: null, perImage: 0.04, note: '' })
r = usage.report(range)
const expected = (3000 / 1e6) * 2 + (1500 / 1e6) * 8 + 2 * 0.04
check('estimate from your rates only where usage was reported', Math.abs((r.totals.estimatedCost ?? 0) - expected) < 1e-9 && r.totals.priced === 3 && r.totals.unpriced === 2, `${r.totals.estimatedCost} vs ${expected}`)
check('rate validation', errOf(() => usage.saveRate({ providerId: 'p1', model: 'gpt-y', inputPerMillion: -1, outputPerMillion: null, perImage: null, note: '' })).includes('between 0') && errOf(() => usage.saveRate({ providerId: 'p1', model: null, inputPerMillion: null, outputPerMillion: null, perImage: null, note: '' })).includes('at least one'))
check('one rate per provider+model', errOf(() => usage.saveRate({ providerId: 'p1', model: null, inputPerMillion: 1, outputPerMillion: 1, perImage: null, note: '', id: '00000000-0000-4000-8000-000000000000' })).includes('already a rate'))
check('provider filter', usage.report({ ...range, providerId: 'p2' }).totals.requests === 1)
check('invalid range refused', errOf(() => usage.report({ from: range.to, to: range.from })).includes('valid date range'))

usage.saveLimit({ providerId: 'p1', period: 'day', metric: 'requests', threshold: 3, action: 'block' })
const lim = usage.listLimits()[0]!
check('limit shows current usage (today, excluding cancelled)', lim.current === 3 && lim.percent === 100, JSON.stringify(lim))
check('block limit stops new requests with a plain reason', (usage.blockedReason('p1') ?? '').includes('daily usage limit for OpenAI'))
check('… other providers unaffected', usage.blockedReason('p2') === null)
usage.evaluate('p1')
usage.evaluate('p1')
check('limit notice once per period', notices.filter((n) => n.title === 'Usage limit reached').length === 1)
usage.saveLimit({ id: lim.id, providerId: 'p1', period: 'day', metric: 'tokens', threshold: 5000, action: 'warn' })
usage.evaluate('p1')
check('80% warning', notices.some((n) => n.title === 'Usage limit almost reached') && usage.blockedReason('p1') === null)
usage.saveLimit({ providerId: null, period: 'month', metric: 'estimated-cost', threshold: 0.05, action: 'warn' })
check('cost limit uses the estimate', usage.listLimits().find((l) => l.metric === 'estimated-cost')!.current > 0)
check('limit validation', errOf(() => usage.saveLimit({ providerId: null, period: 'day', metric: 'tokens', threshold: 1.5, action: 'warn' })).includes('whole number'))

db.close()
console.log(results.join('\n'))
console.log(`\n${results.filter((x) => x.startsWith('FAIL')).length} failed of ${results.length}`)
process.exit(0)
