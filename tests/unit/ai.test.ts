import { rmSync } from 'node:fs'
import { SqliteDatabase } from '../../src/main/services/database/driver'
import { migrate } from '../../src/main/services/database/migrator'
import { AiUsageRepository } from '../../src/main/services/database/sqlite/aiUsageRepository'
import { AiService } from '../../src/main/services/ai/aiService'
import { assertAllowedDestination, createGuardedFetch } from '../../src/main/services/ai/endpointGuard'
import { AiServiceError, sanitizeProviderMessage } from '../../src/main/services/ai/errors'
import { validateEndpoint } from '../../src/shared/config/providers'
import { startOpenAiMock, VALID_KEY } from '../mocks/openaimock.mjs'

// Environment variables the SDK would read by default — must have no effect.
process.env.OPENAI_API_KEY = 'sk-env-LEAK-should-never-be-sent-000000'
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:9/never'
process.env.OPENAI_ORG_ID = 'org-env-leak'
process.env.OPENAI_PROJECT_ID = 'proj-env-leak'
process.env.OPENAI_LOG = 'debug'

const results: string[] = []
const check = (name: string, ok: boolean, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
const logged: string[] = []
const log = { debug() {}, info: (m: string) => logged.push(m), success: (m: string) => logged.push(m), warn: (m: string) => logged.push(m), error: (m: string) => logged.push(m) }
const kindOf = async (p: Promise<unknown>) => p.then(() => 'none', (e) => (e instanceof AiServiceError ? e.kind : `${(e as Error).name}:${(e as Error).message}`))

// ── endpoint rules ──
const ai = (u: string) => validateEndpoint('openai-compatible', u)
check('AI endpoint: public https ok', ai('https://api.openai.com/v1') === null)
check('AI endpoint: loopback http ok (local servers)', ai('http://127.0.0.1:1234/v1') === null && ai('http://localhost:11434/v1') === null)
check('AI endpoint: remote http refused', ai('http://api.example.com/v1') !== null)
check('AI endpoint: private IPv4 refused', [ai('https://10.0.0.4/v1'), ai('http://192.168.1.20:1234/v1'), ai('https://172.20.1.1/v1'), ai('https://169.254.169.254/v1'), ai('https://100.64.0.1/v1')].every(Boolean))
check('AI endpoint: private IPv6 refused', [ai('https://[fd00::1]/v1'), ai('https://[fe80::1]/v1'), ai('https://[::ffff:10.0.0.1]/v1')].every(Boolean))
check('AI endpoint: internal names refused', [ai('https://router/v1'), ai('https://llm.internal/v1'), ai('https://box.local/v1'), ai('https://x.localhost/v1')].every(Boolean))
check('IX endpoint rules unchanged', validateEndpoint('ixbrowser', 'http://127.0.0.1:53200') === null)

const stubLookup = (map: Record<string, string[]>) => async (host: string) => (map[host] ?? ['93.184.216.34']).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
check('guard: public host resolving publicly ok', (await kindOf(assertAllowedDestination(new URL('https://api.example.com/v1'), stubLookup({})))) === 'none')
check('guard: DNS rebinding to private refused', (await kindOf(assertAllowedDestination(new URL('https://evil.example/v1'), stubLookup({ 'evil.example': ['10.1.2.3'] })))) === 'blocked-endpoint')
check('guard: DNS to loopback refused for public name', (await kindOf(assertAllowedDestination(new URL('https://evil.example/v1'), stubLookup({ 'evil.example': ['127.0.0.1'] })))) === 'blocked-endpoint')
check('guard: one private answer among many refused', (await kindOf(assertAllowedDestination(new URL('https://mixed.example/v1'), stubLookup({ 'mixed.example': ['1.1.1.1', 'fd12::1'] })))) === 'blocked-endpoint')
check('guard: metadata literal refused', (await kindOf(assertAllowedDestination(new URL('http://169.254.169.254/'), stubLookup({})))) === 'blocked-endpoint')
check('guard: loopback endpoint allowed', (await kindOf(assertAllowedDestination(new URL('http://127.0.0.1:1234/v1'), stubLookup({})))) === 'none')
const gf = createGuardedFetch('https://api.example.com/v1', { lookup: stubLookup({}), fetchImpl: (async () => new Response('{}')) as typeof fetch })
check('guarded fetch refuses other origins', (await kindOf(gf('https://attacker.example/v1/models'))) === 'blocked-endpoint')
check('sanitize strips key fragments', !/sk-bad|VALIDKEY|abcd1234abcd1234abcd1234abcd1234/.test(sanitizeProviderMessage('Incorrect API key provided: sk-bad***wxyz. token abcd1234abcd1234abcd1234abcd1234')))

// ── service against the mock ──
const mock = await startOpenAiMock()
const endpoint = `http://127.0.0.1:${mock.port}/v1`
const path = process.argv[2]!
for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true })
const db = new SqliteDatabase(path).open()
migrate(db, log)
db.exec("INSERT INTO provider_configs (id, kind, adapter, name, endpoint, created_at, updated_at) VALUES ('11111111-1111-4111-8111-111111111111','openai-compatible','openai','Mock OpenAI','x','x','x'), ('22222222-2222-4222-8222-222222222222','openai-compatible','openai-chat','Mock Chat','x','x','x')")
const usage = new AiUsageRepository(db)
const settingsStore = new Map<string, unknown>()
const settings = { get: <T,>(k: string) => settingsStore.get(k) as T | undefined, set: (k: string, v: unknown) => void settingsStore.set(k, structuredClone(v)), setMany() {}, entries: () => ({}), delete: (k: string) => void settingsStore.delete(k) }
const cfg = (over: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111', kind: 'openai-compatible', adapter: 'openai', name: 'Mock OpenAI', endpoint, model: 'gpt-test-mini', enabled: true,
  settings: { timeoutMs: 5000, retries: 1, generation: { temperature: null, maxOutputTokens: null } },
  credential: { hint: 'cdef', updatedAt: 'k1', present: true }, readiness: { state: 'ready', issues: [] }, createdAt: 'x', updatedAt: 'u1', ...over
})
const configs: Record<string, ReturnType<typeof cfg>> = {
  '11111111-1111-4111-8111-111111111111': cfg(),
  '22222222-2222-4222-8222-222222222222': cfg({ id: '22222222-2222-4222-8222-222222222222', adapter: 'openai-chat', name: 'Mock Chat' })
}
let key: string | null = VALID_KEY
const providers = {
  get: (id: string) => {
    const c = configs[id]
    if (!c) throw Object.assign(new Error('nf'), { name: 'NotFoundError' })
    return c
  },
  list: () => Object.values(configs),
  secretFor: () => key
}
let defaultId: string | null = null
const preferences = { get: () => ({ defaults: { textProviderId: defaultId } }) }
let changes = 0
const svc = new AiService({ providers: providers as never, preferences: preferences as never, settings: settings as never, usage, log, onChange: () => changes++ })
const P1 = '11111111-1111-4111-8111-111111111111'
const P2 = '22222222-2222-4222-8222-222222222222'

const t1 = await svc.testConnection(P1)
check('connection test ok via GET /models', t1.ok && t1.modelCount === 5 && t1.modelListed === true && t1.latencyMs !== null, JSON.stringify(t1.error))
const req0 = mock.state.log.at(-1)!
check('request went to the configured endpoint with our key (env ignored)', req0.path === '/v1/models' && req0.auth === `Bearer ${VALID_KEY}` && req0.org === null && req0.project === null)
const cached = await svc.listModels(P1)
check('models cached; non-text families flagged', cached?.models.length === 5 && cached.models.filter((m) => !m.likelyText).map((m) => m.id).sort().join() === 'gpt-image-test,text-embedding-test,whisper-test')
check('listModels without refresh makes no request', mock.state.log.length === 1)
check('last test visible in overview', svc.overview().tests[P1]?.ok === true)
configs[P1] = cfg({ updatedAt: 'u2', model: 'gpt-test-large' })
check('model change keeps the test valid, re-checks listing', svc.lastTest(configs[P1] as never)?.ok === true && svc.lastTest(configs[P1] as never)?.modelListed === true)
configs[P1] = cfg({ model: 'unlisted-x' })
check('unlisted model flagged from cached list', svc.lastTest(configs[P1] as never)?.modelListed === false)
configs[P1] = cfg({ credential: { hint: 'cdef', updatedAt: 'k2', present: true } })
check('key change invalidates the test', svc.lastTest(configs[P1] as never) === null)
configs[P1] = cfg({ endpoint: endpoint + '/' })
check('endpoint change invalidates the test', svc.lastTest(configs[P1] as never) === null)
configs[P1] = cfg({ model: 'not-listed-model' })
const t2 = await svc.testConnection(P1)
check('test flags model missing from list', t2.ok && t2.modelListed === false)
configs[P1] = cfg()

// generation — Responses API
mock.state.log.length = 0
const g1 = await svc.generateText({ providerId: P1, input: 'Hello there', instructions: 'Be brief.' })
const body1 = mock.state.log.at(-1)!.body
check('responses: text normalised', g1.text === 'Echo: Hello there' && g1.finishReason === 'stop', JSON.stringify(g1))
check('responses: model as reported', g1.model === 'gpt-test-mini-2026-01-01')
check('responses: provider usage kept exactly', g1.usage?.inputTokens === 12 && g1.usage.outputTokens === 7 && g1.usage.totalTokens === 19)
check('responses: provider request id captured', typeof g1.providerRequestId === 'string' && g1.providerRequestId.startsWith('req_'))
check('responses: documented body (store:false, instructions, no unset params)', mock.state.log.at(-1)!.path === '/v1/responses' && body1.store === false && body1.instructions === 'Be brief.' && !('temperature' in body1) && !('max_output_tokens' in body1))
await svc.generateText({ providerId: P1, input: 'x', temperature: 0.4, maxOutputTokens: 64 })
const body2 = mock.state.log.at(-1)!.body
check('responses: parameters forwarded when set', body2.temperature === 0.4 && body2.max_output_tokens === 64)
configs[P1] = cfg({ settings: { timeoutMs: 5000, retries: 1, generation: { temperature: 0.9, maxOutputTokens: 100 } } })
await svc.generateText({ providerId: P1, input: 'x' })
check('provider generation defaults applied', mock.state.log.at(-1)!.body.temperature === 0.9 && mock.state.log.at(-1)!.body.max_output_tokens === 100)
configs[P1] = cfg()

// Chat Completions adapter
const g2 = await svc.generateText({ providerId: P2, input: 'Hi chat', instructions: 'sys', maxOutputTokens: 50 })
const body3 = mock.state.log.at(-1)!.body
check('chat: normalised', g2.text === 'Chat: Hi chat' && g2.adapter === 'openai-chat' && g2.usage?.inputTokens === 9 && g2.usage.outputTokens === 5 && g2.usage.totalTokens === 14)
check('chat: documented body', mock.state.log.at(-1)!.path === '/v1/chat/completions' && body3.messages[0].role === 'system' && body3.messages[1].content === 'Hi chat' && body3.max_tokens === 50)

mock.state.mode = 'no-usage'
const g3 = await svc.generateText({ providerId: P1, input: 'x' })
const g3c = await svc.generateText({ providerId: P2, input: 'x' })
check('missing usage stays null (never invented)', g3.usage === null && g3c.usage === null)
mock.state.mode = 'incomplete'
check('incomplete → finish "length"', (await svc.generateText({ providerId: P1, input: 'x' })).finishReason === 'length' && (await svc.generateText({ providerId: P2, input: 'x' })).finishReason === 'length')
mock.state.mode = 'ok'

// errors
key = 'sk-wrong-KEY-0000000000000000000'
const authErr = await svc.generateText({ providerId: P1, input: 'x' }).catch((e) => e as AiServiceError)
check('invalid key → auth', authErr instanceof AiServiceError && authErr.kind === 'auth' && authErr.status === 401)
check('auth message leaks no key fragment', !/sk-wro|0000|KEY/.test(`${authErr.message} ${authErr.hint}`), authErr.message)
const tBad = await svc.testConnection(P1)
check('connection test with bad key → ok:false auth', !tBad.ok && tBad.error?.kind === 'auth')
key = VALID_KEY
mock.state.mode = 'quota'
check('quota exhausted → quota', (await kindOf(svc.generateText({ providerId: P1, input: 'x' }))) === 'quota')
mock.state.mode = 'rate'
mock.state.log.length = 0
const rateErr = await svc.generateText({ providerId: P1, input: 'x' }).catch((e) => e as AiServiceError)
check('rate limit → rate-limit with retry-after', rateErr.kind === 'rate-limit' && rateErr.retryAfterSec === 1)
check('generation is not retried automatically', mock.state.log.length === 1)
mock.state.mode = 'rate-once'
mock.state.rateCount = 0
mock.state.log.length = 0
const relisted = await svc.listModels(P1, true)
check('model listing retried once after 429 (safe read)', relisted !== null && mock.state.log.length === 2)
mock.state.mode = 'ok'
check('unknown model → model', (await kindOf(svc.generateText({ providerId: P1, model: 'gpt-nope', input: 'x' }))) === 'model')
mock.state.mode = 'unsupported-temp'
const tempErr = await svc.generateText({ providerId: P1, input: 'x', temperature: 1 }).catch((e) => e as AiServiceError)
check('unsupported parameter → invalid-request naming it', tempErr.kind === 'invalid-request' && tempErr.message.includes('temperature'))
mock.state.mode = 'server'
check('5xx → server', (await kindOf(svc.generateText({ providerId: P1, input: 'x' }))) === 'server')
mock.state.mode = 'malformed'
check('malformed body → malformed', (await kindOf(svc.listModels(P1, true))) === 'malformed')
mock.state.mode = 'no-models'
const tNo = await svc.testConnection(P1)
check('server without /models → honest failure, not "connected"', !tNo.ok && tNo.error?.kind === 'invalid-request')
mock.state.mode = 'forbidden'
check('403 → auth (permission)', (await kindOf(svc.generateText({ providerId: P1, input: 'x' }))) === 'auth')
mock.state.mode = 'redirect'
mock.state.log.length = 0
const redir = await kindOf(svc.generateText({ providerId: P1, input: 'x' }))
check('redirects are not followed', redir === 'network' && mock.state.log.length === 1, redir)
mock.state.mode = 'ok'

// timeout & cancellation
configs[P1] = cfg({ settings: { timeoutMs: 1000, retries: 0, generation: { temperature: null, maxOutputTokens: null } } })
mock.state.latency = 2500
const tStart = Date.now()
check('timeout → timeout', (await kindOf(svc.generateText({ providerId: P1, input: 'x' }))) === 'timeout' && Date.now() - tStart < 2400)
configs[P1] = cfg()
mock.state.latency = 1500
const rid = '33333333-3333-4333-8333-333333333333'
const pending = svc.generateText({ providerId: P1, input: 'slow' }, { requestId: rid }).catch((e) => e as AiServiceError)
await new Promise((r) => setTimeout(r, 200))
check('in-flight request visible', svc.overview().inFlight.some((r) => r.requestId === rid))
check('cancel returns true', svc.cancel(rid) === true)
const cancelled = await pending
check('cancelled → cancelled', cancelled instanceof AiServiceError && cancelled.kind === 'cancelled')
check('nothing left in flight', svc.overview().inFlight.length === 0 && svc.cancel(rid) === false)
mock.state.latency = 0

// configuration problems
check('no default provider → not-configured', (await kindOf(svc.generateText({ input: 'x' }))) === 'not-configured')
defaultId = P2
check('default provider used when none given', (await svc.generateText({ input: 'default' })).providerId === P2)
configs[P1] = cfg({ enabled: false })
check('disabled provider → not-configured', (await kindOf(svc.generateText({ providerId: P1, input: 'x' }))) === 'not-configured')
configs[P1] = cfg({ model: null })
check('no model → not-configured', (await kindOf(svc.generateText({ providerId: P1, input: 'x' }))) === 'not-configured')
configs[P1] = cfg({ endpoint: 'https://api.example.com/v1' })
key = null
configs[P1].credential = null as never
check('remote provider without key → not-configured', (await kindOf(svc.generateText({ providerId: P1, input: 'x' }))) === 'not-configured')
key = VALID_KEY
configs[P1] = cfg({ endpoint: 'https://10.0.0.8/v1' })
check('private endpoint in DB → not-configured (validated before use)', (await kindOf(svc.generateText({ providerId: P1, input: 'x' }))) === 'not-configured')
configs[P1] = cfg()
check('empty prompt rejected', (await kindOf(svc.generateText({ providerId: P1, input: '   ' }))).startsWith('ValidationError'))
check('temperature out of range rejected', (await kindOf(svc.generateText({ providerId: P1, input: 'x', temperature: 3 }))).startsWith('ValidationError'))
check('test prompt length capped', (await kindOf(svc.testPrompt({ providerId: P1, requestId: rid, prompt: 'x'.repeat(501) }))).startsWith('ValidationError'))
mock.state.log.length = 0
await svc.testPrompt({ providerId: P1, requestId: rid, prompt: 'Say ok' })
check('test prompt caps output tokens at 200', mock.state.log.at(-1)!.body.max_output_tokens === 200)

// usage persistence
const all = usage.query({ limit: 1000 })
const succeededGen = all.filter((r) => r.operation === 'generate-text' && r.status === 'succeeded')
check('every request that reached the provider recorded (26)', all.length === 26, String(all.length))
check('usage rows keep reported tokens, null when absent', succeededGen.some((r) => r.usage?.totalTokens === 19) && succeededGen.some((r) => r.usage === null))
check('failed rows carry error kind', all.some((r) => r.status === 'failed' && r.errorKind === 'quota') && all.some((r) => r.status === 'cancelled'))
check('no cost estimates recorded', all.every((r) => r.estimatedCostUsd === null))
const s = usage.summary({})
check('summary totals consistent', s.requests === all.length && s.succeeded + s.failed + s.cancelled === s.requests && s.totalTokens === all.reduce((n, r) => n + (r.usage?.totalTokens ?? 0), 0))
check('filter by provider', usage.query({ providerId: P2, limit: 1000 }).every((r) => r.providerId === P2) && usage.query({ providerId: P2 }).length > 0)
check('filter by operation + status', usage.query({ operation: 'connection-test', status: 'failed' }).every((r) => r.operation === 'connection-test' && r.status === 'failed'))
check('filter by date', usage.query({ from: '2999-01-01T00:00:00.000Z' }).length === 0 && usage.query({ to: '2000-01-01T00:00:00.000Z' }).length === 0)
db.exec(`DELETE FROM provider_configs WHERE id = '${P2}'`)
check('usage survives provider removal (name kept)', usage.query({ limit: 1000 }).some((r) => r.providerId === null && r.providerName === 'Mock Chat'))
check('logs contain no key or prompt text', !logged.some((l) => /VALIDKEY|sk-wrong|Hello there|Hi chat/.test(l)))

db.close()
await mock.close()
console.log(results.join('\n'))
console.log(`\n${results.filter((x) => x.startsWith('FAIL')).length} failed of ${results.length}`)
process.exit(0)
