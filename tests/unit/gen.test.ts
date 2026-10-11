import { rmSync } from 'node:fs'
import { SqliteDatabase } from '../../src/main/services/database/driver'
import { migrate } from '../../src/main/services/database/migrator'
import { createSqliteRepositories } from '../../src/main/services/database/sqlite'
import { AiUsageRepository } from '../../src/main/services/database/sqlite/aiUsageRepository'
import { GenerationRepository } from '../../src/main/services/database/sqlite/generationRepository'
import { AssetRepository } from '../../src/main/services/database/sqlite/assetRepository'
import { AiService } from '../../src/main/services/ai/aiService'
import { DraftService } from '../../src/main/services/drafts/draftService'
import { GeneratorService } from '../../src/main/services/generator/generatorService'
import { parseResults } from '../../src/main/services/generator/parse'
import { buildAssistPrompt, buildGenerationPrompt } from '../../src/main/services/generator/prompts'
import { composePost, normalizeHashtag } from '../../src/shared/config/postLimits'
import type { GenerationBrief } from '../../src/shared/types/generator'
import { startOpenAiMock, VALID_KEY } from '../mocks/openaimock.mjs'

const results: string[] = []
const check = (name: string, ok: boolean, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
const logged: string[] = []
const log = { debug() {}, info: (m: string, meta?: unknown) => logged.push(m + JSON.stringify(meta ?? {})), success: (m: string) => logged.push(m), warn: (m: string) => logged.push(m), error: (m: string) => logged.push(m) }
const errOf = async (p: Promise<unknown>) => p.then(() => 'none', (e) => `${(e as Error).name}: ${(e as Error).message}`)

// ── pure helpers ──
check('parse plain JSON', JSON.stringify(parseResults('{"variations":["a","b"]}', 'variations', 2)) === '["a","b"]')
check('parse fenced JSON with prose', JSON.stringify(parseResults('Sure:\n```json\n{"variations":["one","two"]}\n```', 'variations', 2)) === '["one","two"]')
check('parse strips quotes, drops empties and duplicates', JSON.stringify(parseResults('{"variations":["“hi”","","hi","yo"]}', 'variations', 3)) === '["hi","yo"]')
check('parse bare array', JSON.stringify(parseResults('["x","y"]', 'variations', 2)) === '["x","y"]')
check('prose for multi-variation request → null (no guessing)', parseResults('Here are ideas…', 'variations', 3) === null)
check('prose for single result → that text', JSON.stringify(parseResults('Just one post.', 'variations', 1)) === '["Just one post."]')
check('hashtags normalised, deduped, digits-only dropped', JSON.stringify(parseResults('{"hashtags":["#Launch","launch","offline first","123","Café"]}', 'hashtags', 8)) === '["Launch","offlinefirst","Café"]')
check('normalizeHashtag', normalizeHashtag('#Rust_Lang') === 'Rust_Lang' && normalizeHashtag('bad-tag') === null && normalizeHashtag('2024') === null && normalizeHashtag('日本') === '日本')
check('composePost appends missing tags only', composePost('Ship it #launch', ['Launch', 'dev']) === 'Ship it #launch\n\n#dev' && composePost('Hi', []) === 'Hi')

const brief: GenerationBrief = {
  topic: 'Offline mode', keyPoints: 'Works without internet. Syncs later.', audience: 'developers', tone: 'informative', language: 'German',
  length: 'short', variations: 3, hashtags: ['Launch'], suggestHashtags: false, callToAction: 'Try it today', instructions: 'No emoji', lengthProfile: 'standard'
}
const p1 = buildGenerationPrompt(brief)
check('generation prompt: count, language, tone, limit, hashtags, CTA, no-invention rule', /exactly 3/.test(p1.instructions) && p1.instructions.includes('German') && p1.instructions.includes('informative') && p1.instructions.includes('at most 120') && p1.instructions.includes('#Launch') && p1.instructions.includes('call to action') && /Do not invent facts/.test(p1.instructions))
check('generation prompt input carries the brief', p1.input.includes('Offline mode') && p1.input.includes('Syncs later') && p1.input.includes('Try it today') && p1.input.includes('No emoji'))
check('premium long-form allows longer target', buildGenerationPrompt({ ...brief, length: 'long', lengthProfile: 'premium' }).instructions.includes('at most 1200'))
const a1 = buildAssistPrompt({ tool: 'translate', text: 'Hello world', hashtags: [], draftId: null, language: 'French', lengthProfile: 'standard' })
check('assist prompt: translate target + text', a1.instructions.includes('French') && a1.input.includes('Hello world') && a1.key === 'variations')
check('assist prompt: hashtags tool uses hashtags key', buildAssistPrompt({ tool: 'hashtags', text: 'x', hashtags: ['a'], draftId: null, lengthProfile: 'standard' }).key === 'hashtags')
check('assist prompt: alternatives count', /exactly 4/.test(buildAssistPrompt({ tool: 'alternatives', text: 'x', hashtags: [], draftId: null, variations: 4, lengthProfile: 'standard' }).instructions))

// ── services against the mock ──
const mock = await startOpenAiMock()
const endpoint = `http://127.0.0.1:${mock.port}/v1`
const path = process.argv[2]!
for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true })
const db = new SqliteDatabase(path).open()
check('migrate → v12', migrate(db, log) === 12)
const repos = createSqliteRepositories(db)
const P = '11111111-1111-4111-8111-111111111111'
db.exec(`INSERT INTO provider_configs (id, kind, adapter, name, endpoint, model, created_at, updated_at) VALUES ('${P}','openai-compatible','openai','Mock','${endpoint}','gpt-test-mini','x','x')`)
const cfg = { id: P, kind: 'openai-compatible', adapter: 'openai', name: 'Mock', endpoint, model: 'gpt-test-mini', enabled: true, settings: { timeoutMs: 3000, retries: 0, generation: { temperature: null, maxOutputTokens: null } }, credential: { hint: 'x', updatedAt: 'k', present: true }, readiness: { state: 'ready', issues: [] }, createdAt: 'x', updatedAt: 'x' }
let key: string | null = VALID_KEY
const providers = { get: (id: string) => { if (id !== P) throw new Error('nf'); return cfg }, list: () => [cfg], secretFor: () => key }
let defaultId: string | null = P
const preferences = { get: () => ({ defaults: { textProviderId: defaultId } }) }
const settingsStore = new Map<string, unknown>()
const settings = { get: (k: string) => settingsStore.get(k), set: (k: string, v: unknown) => void settingsStore.set(k, v), setMany() {}, entries: () => ({}), delete() {} }
const ai = new AiService({ providers: providers as never, preferences: preferences as never, settings: settings as never, usage: new AiUsageRepository(db), log, onChange() {} })
const generations = new GenerationRepository(db)
const gen = new GeneratorService({ ai, providers: providers as never, preferences: preferences as never, generations, log })
const drafts = new DraftService(repos, db, new AssetRepository(db), log)
const rid = () => crypto.randomUUID()

const g1 = await gen.generate(brief, { requestId: rid() })
check('generate: 3 real variations from the provider', g1.status === 'succeeded' && g1.results.length === 3 && g1.results[0] === 'Variation 1 about Offline mode', JSON.stringify(g1.results))
check('generate: provider, model, usage recorded', g1.providerName === 'Mock' && g1.model === 'gpt-test-mini-2026-01-01' && g1.usage?.totalTokens === 19)
const stored = generations.get(g1.id)!
check('history persisted with settings and results', stored.results.length === 3 && (stored.settings as GenerationBrief).tone === 'informative' && (stored.settings as GenerationBrief).language === 'German')
check('history links to the usage record', Boolean(db.get(`SELECT 1 FROM generations g JOIN ai_usage u ON u.id = g.usage_record_id WHERE g.id = '${g1.id}'`)))
const sentBody = mock.state.log.at(-1)!.body
check('one request for all variations; prompt sent as instructions', mock.state.log.filter((l) => l.path === '/v1/responses').length === 1 && String(sentBody.instructions).includes('exactly 3'))
check('no secrets in history rows', !JSON.stringify(db.all('SELECT * FROM generations')).includes(VALID_KEY))

mock.state.mode = 'fenced'
check('fenced JSON answer still parsed', (await gen.generate({ ...brief, variations: 2 }, { requestId: rid() })).results.length === 2)
mock.state.mode = 'prose'
const g2 = await gen.generate(brief, { requestId: rid() })
check('unparseable answer → failed record, no invented results', g2.status === 'failed' && g2.results.length === 0 && g2.error?.kind === 'malformed')
mock.state.mode = 'quota'
const g3 = await gen.generate(brief, { requestId: rid() })
check('quota → failed record with quota error', g3.status === 'failed' && g3.error?.kind === 'quota' && g3.providerName === 'Mock')
mock.state.mode = 'ok'
key = 'sk-wrong-000000000000000000000'
const g4 = await gen.generate(brief, { requestId: rid() })
check('invalid key → auth error recorded, key never stored', g4.error?.kind === 'auth' && !JSON.stringify(db.all('SELECT * FROM generations')).includes('sk-wrong'))
key = VALID_KEY
cfg.settings.timeoutMs = 1000
mock.state.latency = 2000
check('timeout → timeout record', (await gen.generate(brief, { requestId: rid() })).error?.kind === 'timeout')
cfg.settings.timeoutMs = 3000
mock.state.latency = 1500
const cancelId = rid()
const pending = gen.generate(brief, { requestId: cancelId })
await new Promise((r) => setTimeout(r, 200))
ai.cancel(cancelId)
const g5 = await pending
check('cancel → cancelled record', g5.status === 'cancelled')
mock.state.latency = 0
defaultId = null
const g6 = await gen.generate(brief, { requestId: rid() })
check('no provider → not-configured record (honest)', g6.status === 'failed' && g6.error?.kind === 'not-configured' && g6.providerName === 'No provider')
defaultId = P

check('validation: empty topic and points', (await errOf(gen.generate({ ...brief, topic: '', keyPoints: ' ' }, { requestId: rid() }))).startsWith('ValidationError'))
check('validation: bad tone / variations / language / hashtag', (await Promise.all([
  errOf(gen.generate({ ...brief, tone: 'angry' as never }, { requestId: rid() })),
  errOf(gen.generate({ ...brief, variations: 9 }, { requestId: rid() })),
  errOf(gen.generate({ ...brief, language: 'x<script>' }, { requestId: rid() })),
  errOf(gen.generate({ ...brief, hashtags: ['bad tag!'] }, { requestId: rid() }))
])).every((e) => e.startsWith('ValidationError')))

// drafts
const d1 = await drafts.save({ body: 'Hand written post', hashtags: ['#Launch', 'launch', 'dev'], accountId: null })
check('manual draft: origin manual, hashtags normalised + deduped', d1.origin === 'manual' && JSON.stringify(d1.hashtags) === '["Launch","dev"]' && d1.status === 'draft')
const d1b = await drafts.save({ id: d1.id, body: 'Hand written post v2', accountId: null, status: 'ready' })
check('edit keeps hashtags, sets status, updates timestamp', JSON.stringify(d1b.hashtags) === '["Launch","dev"]' && d1b.status === 'ready' && d1b.updatedAt >= d1.updatedAt && d1b.createdAt === d1.createdAt)
const a2 = await gen.assist({ tool: 'shorten', text: d1b.body, hashtags: d1b.hashtags, draftId: d1.id, lengthProfile: 'standard' }, { requestId: rid() })
check('assist: result returned, draft untouched', a2.status === 'succeeded' && a2.results.length === 1 && (await drafts.get(d1.id)).body === 'Hand written post v2')
check('assist history linked to draft', generations.list({ draftId: d1.id }).length === 1 && a2.sourceText === 'Hand written post v2')
const a3 = await gen.assist({ tool: 'alternatives', text: 'abc', hashtags: [], draftId: null, variations: 4, lengthProfile: 'standard' }, { requestId: rid() })
check('alternatives returns 4', a3.results.length === 4)
const a4 = await gen.assist({ tool: 'hashtags', text: 'We launched offline mode', hashtags: ['Windows'], draftId: d1.id, lengthProfile: 'standard' }, { requestId: rid() })
check('hashtag suggestions normalised', a4.status === 'succeeded' && a4.results.includes('ProductLaunch') && a4.results.includes('offlinefirst') && !a4.results.includes('123'), JSON.stringify(a4.results))
const a5 = await gen.assist({ tool: 'translate', text: 'Hi', hashtags: [], draftId: null, language: 'Japanese', lengthProfile: 'standard' }, { requestId: rid() })
check('translate settings recorded', (a5.settings as { language?: string }).language === 'Japanese')
check('assist on empty text rejected', (await errOf(gen.assist({ tool: 'rewrite', text: '  ', hashtags: [], draftId: null, lengthProfile: 'standard' }, { requestId: rid() }))).startsWith('ValidationError'))

const replaced = await drafts.save({ id: d1.id, body: a2.results[0]!, accountId: null, aiAssisted: true, sourceGenerationId: a2.id })
check('replacing text marks draft AI-assisted, links generation', replaced.origin === 'ai' && replaced.sourceGenerationId === a2.id)
const back = await drafts.save({ id: d1.id, body: 'Manual again', accountId: null })
check('AI-assisted stays AI-assisted after manual edit', back.origin === 'ai')
const fromResult = await drafts.save({ body: g1.results[1]!, accountId: null, sourceGenerationId: g1.id })
check('reuse a history result as a new draft → origin ai', fromResult.origin === 'ai' && fromResult.sourceGenerationId === g1.id)
const dup = await drafts.duplicate(d1.id)
check('duplicate: new id, same text/hashtags, status reset', dup.id !== d1.id && dup.body === 'Manual again' && JSON.stringify(dup.hashtags) === JSON.stringify(back.hashtags) && dup.status === 'draft')
check('draft validation: empty, too long, bad hashtag, unknown account, unknown generation', (await Promise.all([
  errOf(drafts.save({ body: '   ', accountId: null })),
  errOf(drafts.save({ body: 'x'.repeat(25_001), accountId: null })),
  errOf(drafts.save({ body: 'x', hashtags: ['no spaces allowed'], accountId: null })),
  errOf(drafts.save({ body: 'x', accountId: '99999999-9999-4999-8999-999999999999' })),
  errOf(drafts.save({ body: 'x', accountId: null, sourceGenerationId: '99999999-9999-4999-8999-999999999999' }))
])).every((e) => e.startsWith('ValidationError')))
check('hashtag-only draft allowed', (await drafts.save({ body: '', hashtags: ['OnlyTags'], accountId: null })).hashtags[0] === 'OnlyTags')
check('editing unknown draft → NotFound', (await errOf(drafts.save({ id: '99999999-9999-4999-8999-999999999999', body: 'x', accountId: null }))).startsWith('NotFoundError'))
db.exec(`UPDATE drafts SET status = 'published' WHERE id = '${dup.id}'`)
check('published drafts cannot be edited', (await errOf(drafts.save({ id: dup.id, body: 'x', accountId: null }))).startsWith('ValidationError'))
await drafts.remove(d1.id)
check('delete draft keeps its generation history (draft link nulled)', generations.get(a2.id)?.draftId === null && generations.get(a2.id)?.results.length === 1)
check('generated draft survives deleting nothing else', (await drafts.list()).some((d) => d.id === fromResult.id))
check('history filters', generations.list({ operation: 'generate' }).every((g) => g.operation === 'generate') && generations.list({ operation: 'assist' }).every((g) => g.operation !== 'generate'))

const before = (await drafts.list()).length
const genCount = generations.list({ limit: 200 }).length
db.close()
const db2 = new SqliteDatabase(path).open()
migrate(db2, log)
const repos2 = createSqliteRepositories(db2)
const after = await repos2.drafts.list()
check('drafts persist across reopen (with hashtags + source)', after.length === before && after.some((d) => d.sourceGenerationId === g1.id) && after.some((d) => d.hashtags.includes('OnlyTags')))
check('generation history persists across reopen', new GenerationRepository(db2).list({ limit: 200 }).length === genCount && genCount > 10, String(genCount))
check('logs carry no prompt or draft text', !logged.some((l) => /Offline mode|Hand written|Works without internet/.test(l)))
db2.close()
await mock.close()
console.log(results.join('\n'))
console.log(`\n${results.filter((x) => x.startsWith('FAIL')).length} failed of ${results.length}`)
process.exit(0)
