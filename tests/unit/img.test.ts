import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SqliteDatabase } from '../../src/main/services/database/driver'
import { migrate } from '../../src/main/services/database/migrator'
import { createSqliteRepositories } from '../../src/main/services/database/sqlite'
import { AiUsageRepository } from '../../src/main/services/database/sqlite/aiUsageRepository'
import { AssetRepository } from '../../src/main/services/database/sqlite/assetRepository'
import { ImageGenerationRepository } from '../../src/main/services/database/sqlite/imageGenerationRepository'
import { AiService } from '../../src/main/services/ai/aiService'
import { AssetService } from '../../src/main/services/assets/assetService'
import { inspectImage } from '../../src/main/services/assets/imageInfo'
import { DraftService } from '../../src/main/services/drafts/draftService'
import { ImageService } from '../../src/main/services/images/imageService'
import { imageModelCapabilities } from '../../src/shared/config/imageModels'
import { attachmentProblem, attachmentSetProblem } from '../../src/shared/config/mediaLimits'
import { startOpenAiMock, VALID_KEY } from '../mocks/openaimock.mjs'

const FIX = process.env.AXORA_TEST_FIXTURES! // prepared by tests/run-unit.mjs
const results: string[] = []
const check = (name: string, ok: boolean, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
const logged: string[] = []
const log = { debug() {}, info: (m: string) => logged.push(m), success: (m: string) => logged.push(m), warn: (m: string) => logged.push(m), error: (m: string) => logged.push(m) }
const errOf = async (p: Promise<unknown>) => p.then(() => 'none', (e) => `${(e as Error).name}: ${(e as Error).message}`)
const fx = (name: string) => readFileSync(join(FIX, name))

// ── content sniffing ──
const info = (name: string) => inspectImage(fx(name))
const ok = (name: string, mime: string, w: number, h: number, animated = false) => {
  const i = info(name)
  return typeof i !== 'string' && i.mimeType === mime && i.width === w && i.height === h && i.animated === animated
}
check('JPEG detected with dimensions', ok('photo.jpg', 'image/jpeg', 800, 600))
check('PNG detected with dimensions', ok('pic.png', 'image/png', 640, 480))
check('WEBP detected with dimensions', ok('pic.webp', 'image/webp', 512, 512))
check('still GIF not animated', ok('still.gif', 'image/gif', 200, 200, false))
check('animated GIF detected', ok('anim.gif', 'image/gif', 120, 120, true))
check('truncated JPEG rejected', typeof info('truncated.jpg') === 'string', String(info('truncated.jpg')))
check('text file renamed .png rejected (content, not extension)', typeof info('fake.png') === 'string')
check('animated WEBP rejected with a reason', String(info('anim.webp')).includes('Animated WEBP'))
check('random bytes rejected', typeof inspectImage(Buffer.from('MZ\x90\x00 this pretends to be an exe'.padEnd(64, 'x'))) === 'string')

// ── limits & capabilities ──
check('attach rule: 6 MB still image too big for X', attachmentProblem({ mimeType: 'image/jpeg', sizeBytes: 6_141_630, animated: false })?.includes('5 MB') === true)
check('attach rule: animated GIF up to 15 MB ok', attachmentProblem({ mimeType: 'image/gif', sizeBytes: 10_000_000, animated: true }) === null)
check('attach rule: GIF must be alone, max 4 photos', attachmentSetProblem([{ animated: true }, { animated: false }]) !== null && attachmentSetProblem(Array(5).fill({ animated: false })) !== null && attachmentSetProblem(Array(4).fill({ animated: false })) === null)
const gpt = imageModelCapabilities('gpt-image-1')
const d3 = imageModelCapabilities('dall-e-3')
check('gpt-image caps from SDK docs', gpt.sizes.includes('1536x1024') && gpt.qualities?.join() === 'auto,low,medium,high' && gpt.formats?.length === 3 && !gpt.requestBase64)
check('gpt-image-2.5 adds xhigh/max', imageModelCapabilities('gpt-image-2.5-flare-2026-09-08').qualities?.includes('max') === true)
check('dall-e-3 caps: 1792 sizes, hd, n=1, base64 requested', d3.sizes.includes('1792x1024') && d3.qualities?.includes('hd') === true && d3.maxImages === 1 && d3.requestBase64 && d3.formats === null)
check('unknown model: conservative profile', !imageModelCapabilities('mystery-model').known && imageModelCapabilities('mystery-model').sizes.join() === '1024x1024')

// ── services ──
const mock = await startOpenAiMock()
const endpoint = `http://127.0.0.1:${mock.port}/v1`
const path = process.argv[2]!
const dir = `${path}-assets`
for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true })
rmSync(dir, { recursive: true, force: true })
const db = new SqliteDatabase(path).open()
check('migrate → v13', migrate(db, log) === 13)
const assetExists = (rel: string) => existsSync(join(dir, rel))
const repos = createSqliteRepositories(db, { assetExists })
const assetRepo = new AssetRepository(db)
let changes = 0
const assets = new AssetService({ repo: assetRepo, dir, log, onChange: () => changes++ })

const imp = await assets.importFiles(['photo.jpg', 'pic.png', 'pic.webp', 'still.gif', 'anim.gif', 'mid.jpg', 'big.jpg', 'truncated.jpg', 'fake.png', 'anim.webp', 'nope.jpg'].map((f) => join(FIX, f)))
check('valid images imported (6)', imp.imported.length === 6, imp.imported.map((a) => a.originalName).join())
check('rejected with reasons (big, truncated, fake, anim webp, missing)', imp.rejected.length === 5 && imp.rejected.find((r) => r.name === 'big.jpg')?.reason.includes('15 MB') === true && imp.rejected.find((r) => r.name === 'nope.jpg')?.reason === 'The file could not be read.', JSON.stringify(imp.rejected))
const photo = imp.imported.find((a) => a.originalName === 'photo.jpg')!
check('metadata recorded', photo.mimeType === 'image/jpeg' && photo.width === 800 && photo.height === 600 && photo.sizeBytes === 21568 && photo.origin === 'upload' && photo.kept && photo.available && photo.url === `relay-asset://asset/${photo.id}`)
const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => !f.match(/^\d{4}-\d{2}$/))
check('files stored under generated names in the app folder, no temp files left', files.length === 6 && files.every((f) => /^\d{4}-\d{2}[/\\][0-9a-f-]{36}\.(jpg|png|webp|gif)$/.test(f)), files.join())
check('SQLite holds a relative path only', String(db.get<{ p: string }>(`SELECT file_path p FROM image_assets WHERE id='${photo.id}'`)?.p).match(/^\d{4}-\d{2}\/[0-9a-f-]+\.jpg$/) !== null)
const again = await assets.importFiles([join(FIX, 'photo.jpg')])
check('same file again → existing asset reused (no duplicate)', again.imported.length === 0 && again.existing[0]?.id === photo.id && assets.list().length === 6)
check('library search/sort', assets.list({ search: 'pic' }).length === 2 && assets.list({ sort: 'largest' })[0]?.originalName === 'mid.jpg' && assets.list({ sort: 'name' })[0]?.originalName === 'anim.gif')
check('file served only from inside the folder', assets.fileFor(photo.id)?.path.startsWith(dir) === true && assets.fileFor('../../etc/passwd') === null)

// image generation
const P = '11111111-1111-4111-8111-111111111111'
const T = '22222222-2222-4222-8222-222222222222'
db.exec(`INSERT INTO provider_configs (id, kind, adapter, name, endpoint, model, created_at, updated_at) VALUES
  ('${P}','image','openai-images','Mock Images','${endpoint}','gpt-image-test','x','x'),
  ('${T}','openai-compatible','openai-chat','Mock Text','${endpoint}','gpt-test-mini','x','x')`)
const base = { enabled: true, credential: { hint: 'x', updatedAt: 'k', present: true }, readiness: { state: 'ready', issues: [] }, createdAt: 'x', updatedAt: 'x' }
const configs: Record<string, any> = {
  [P]: { ...base, id: P, kind: 'image', adapter: 'openai-images', name: 'Mock Images', endpoint, model: 'gpt-image-test', settings: { timeoutMs: 5000, retries: 0, image: { size: '1024x1024', quality: null, format: null } } },
  [T]: { ...base, id: T, kind: 'openai-compatible', adapter: 'openai-chat', name: 'Mock Text', endpoint, model: 'gpt-test-mini', settings: { timeoutMs: 5000, retries: 0, generation: { temperature: null, maxOutputTokens: null } } }
}
let key: string | null = VALID_KEY
const providers = { get: (id: string) => { if (!configs[id]) throw new Error('nf'); return configs[id] }, list: (k?: string) => Object.values(configs).filter((c) => !k || c.kind === k), secretFor: () => key }
const defaults = { textProviderId: T as string | null, imageProviderId: P as string | null }
const preferences = { get: () => ({ defaults }) }
const settingsStore = new Map<string, unknown>()
const settings = { get: (k: string) => settingsStore.get(k), set: (k: string, v: unknown) => void settingsStore.set(k, v), setMany() {}, entries: () => ({}), delete() {} }
const usageRepo = new AiUsageRepository(db)
const ai = new AiService({ providers: providers as never, preferences: preferences as never, settings: settings as never, usage: usageRepo, log, onChange() {} })
const generations = new ImageGenerationRepository(db)
const images = new ImageService({ ai, assets, providers: providers as never, preferences: preferences as never, generations, log })
const rid = () => crypto.randomUUID()
const req = (over: Record<string, unknown> = {}) => ({ prompt: 'A lighthouse at dawn', size: '1536x1024', quality: 'high', format: 'jpeg' as const, transparent: false, count: 2, draftId: null, ...over })

const t = await ai.testConnection(P)
check('image provider connection test (GET /models)', t.ok && t.modelListed === true)
const g1 = await images.generate(req(), { requestId: rid() })
check('generated 2 real images from the provider', g1.status === 'succeeded' && g1.assets.length === 2 && g1.assets.every((a) => a.origin === 'generated' && a.mimeType === 'image/jpeg' && a.width === 1536 && a.height === 1024), JSON.stringify(g1.error))
const sent = mock.state.log.at(-1)!.body
check('documented parameters sent (model, size, quality, format, n), no response_format for GPT image', sent.model === 'gpt-image-test' && sent.size === '1536x1024' && sent.quality === 'high' && sent.output_format === 'jpeg' && sent.n === 2 && !('response_format' in sent))
check('identical result bytes stored once', new Set(g1.assets.map((a) => a.id)).size === 1)
check('generated images not kept until saved', g1.assets.every((a) => !a.kept) && !assets.list().some((a) => a.id === g1.assets[0]!.id))
check('usage recorded with tokens, size, format, count', (() => {
  const u = usageRepo.query({ operation: 'generate-image' })[0]
  return u?.status === 'succeeded' && u.imageCount === 2 && u.imageSize === '1536x1024' && u.imageFormat === 'jpeg' && u.imageQuality === 'high' && u.usage?.totalTokens === 1077 && u.estimatedCostUsd === null
})())
check('history persisted with asset links', images.history()[0]?.id === g1.id && images.history()[0]!.assets.length >= 1 && images.history()[0]!.usage?.totalTokens === 1077)
const kept = assets.keep(g1.assets[0]!.id)
check('save to library keeps it', kept.kept && assets.list().some((a) => a.id === kept.id))

check('unsupported size rejected before sending', (await errOf(images.generate(req({ size: '1792x1024' }), { requestId: rid() }))).includes('supports these sizes'))
check('unsupported quality rejected', (await errOf(images.generate(req({ quality: 'hd' }), { requestId: rid() }))).startsWith('ValidationError'))
check('transparent + jpeg rejected', (await errOf(images.generate(req({ transparent: true }), { requestId: rid() }))).includes('PNG or WEBP'))
check('too many images rejected', (await errOf(images.generate(req({ count: 5 }), { requestId: rid() }))).startsWith('ValidationError'))
check('empty prompt rejected', (await errOf(images.generate(req({ prompt: '  ' }), { requestId: rid() }))).startsWith('ValidationError'))

mock.state.models.push('dall-e-3')
const g2 = await images.generate(req({ size: '1792x1024', quality: 'hd', format: null, count: 1 }), { requestId: rid(), model: 'dall-e-3' })
const sent2 = mock.state.log.at(-1)!.body
check('dall-e-3: base64 requested, no output_format, revised prompt kept', g2.status === 'succeeded' && sent2.response_format === 'b64_json' && !('output_format' in sent2) && g2.revisedPrompt === 'A revised prompt')
check('dall-e-3: no usage reported → null (not invented)', g2.usage === null)

const fail = async (mode: string, over: Record<string, unknown> = {}) => {
  mock.state.mode = mode
  const r = await images.generate(req(over), { requestId: rid() })
  mock.state.mode = 'ok'
  return r
}
check('quota → failed record, no images', (await fail('quota')).error?.kind === 'quota')
check('rate limit → rate-limit', (await fail('rate')).error?.kind === 'rate-limit')
check('bad size from provider → invalid-request', (await fail('img-bad-size')).error?.kind === 'invalid-request')
check('empty data → malformed', (await fail('img-empty')).error?.kind === 'malformed')
const garbage = await fail('img-garbage')
check('non-image bytes → failed, nothing saved', garbage.status === 'failed' && garbage.assets.length === 0 && generations.get(garbage.id)?.status === 'failed')
check('http result URL refused (https only), not downloaded', (await fail('img-url')).error?.kind === 'blocked-endpoint')
key = 'sk-wrong-00000000000000000000000'
check('invalid key → auth', (await fail('ok')).error?.kind === 'auth')
key = VALID_KEY
configs[P].settings.timeoutMs = 1000
mock.state.latency = 2000
check('timeout → timeout', (await images.generate(req(), { requestId: rid() })).error?.kind === 'timeout')
configs[P].settings.timeoutMs = 5000
mock.state.latency = 1500
const cancelId = rid()
const pending = images.generate(req(), { requestId: cancelId })
await new Promise((r) => setTimeout(r, 200))
ai.cancel(cancelId)
check('cancel → cancelled', (await pending).status === 'cancelled')
mock.state.latency = 0
defaults.imageProviderId = null
check('no image provider → not-configured', (await images.generate(req(), { requestId: rid() })).error?.kind === 'not-configured')
defaults.imageProviderId = P
check('text provider refused for image generation', (await errOf(images.generate(req(), { requestId: rid(), providerId: T }))).includes('not an image provider'))
check('image provider refused for text generation', (await errOf(ai.generateText({ providerId: P, input: 'x' }))).includes('not an AI text provider'))

// prompt suggestion via the text provider
const s1 = await images.suggestPrompt({ postText: 'We launched offline mode for our notes app.', style: 'watercolor', instructions: 'cosy', requestId: rid() })
const sys = mock.state.log.at(-1)!.body.messages[0].content
check('prompt suggestion uses the text provider with style + no-unrelated-subjects rule', s1.ok && mock.state.log.at(-1)!.path === '/v1/chat/completions' && sys.includes('watercolor') && /no unrelated/i.test(sys) && mock.state.log.at(-1)!.body.messages[1].content.includes('offline mode'))
mock.state.mode = 'quota'
const s2 = await images.suggestPrompt({ postText: 'x', style: 'photographic', instructions: '', requestId: rid() })
mock.state.mode = 'ok'
check('prompt suggestion failure reported, nothing invented', !s2.ok && s2.error.kind === 'quota')
check('prompt suggestion needs post text', (await errOf(images.suggestPrompt({ postText: ' ', style: 'photographic', instructions: '', requestId: rid() }))).startsWith('ValidationError'))

// drafts with attachments
const drafts = new DraftService(repos, db, assetRepo, log, assetExists)
const webp = imp.imported.find((a) => a.originalName === 'pic.webp')!
const png = imp.imported.find((a) => a.originalName === 'pic.png')!
const anim = imp.imported.find((a) => a.originalName === 'anim.gif')!
const mid = imp.imported.find((a) => a.originalName === 'mid.jpg')!
const photo2 = (await assets.importFiles([join(FIX, 'photo2.jpg')])).imported[0]!
const d1 = await drafts.save({ body: 'Post with images', accountId: null, attachments: [{ assetId: webp.id, altText: 'A yellow sun' }, { assetId: photo.id, altText: '' }] })
check('attachments saved in order with alt text', d1.media.map((m) => m.id).join() === `${webp.id},${photo.id}` && d1.media[0]!.altText === 'A yellow sun' && d1.media[0]!.url.startsWith('relay-asset://'))
const d1b = await drafts.save({ id: d1.id, body: 'Post with images', accountId: null, attachments: [{ assetId: photo.id, altText: '' }, { assetId: webp.id, altText: 'A yellow sun' }] })
check('reorder persisted', d1b.media.map((m) => m.id).join() === `${photo.id},${webp.id}`)
const d1c = await drafts.save({ id: d1.id, body: 'Post with images (edited)', accountId: null })
check('omitting attachments keeps them', d1c.media.length === 2)
const d1d = await drafts.save({ id: d1.id, body: 'Post with images', accountId: null, attachments: [{ assetId: png.id, altText: '' }, { assetId: webp.id, altText: 'A yellow sun' }] })
check('replace an attachment', d1d.media.map((m) => m.id).join() === `${png.id},${webp.id}`)
check('attaching keeps generated images in the library', (await drafts.save({ body: 'gen', accountId: null, attachments: [{ assetId: g2.assets[0]!.id, altText: '' }] })).media.length === 1 && assetRepo.get(g2.assets[0]!.id)?.kept === true)
check('image-only draft allowed', (await drafts.save({ body: '', accountId: null, attachments: [{ assetId: photo.id, altText: '' }] })).media.length === 1)
check('rule checks: >4, GIF with others, >5 MB still, long alt, unknown asset', (await Promise.all([
  errOf(drafts.save({ body: 'x', accountId: null, attachments: [photo, png, webp, kept, photo2].map((a) => ({ assetId: a.id, altText: '' })) })),
  errOf(drafts.save({ body: 'x', accountId: null, attachments: [{ assetId: anim.id, altText: '' }, { assetId: photo.id, altText: '' }] })),
  errOf(drafts.save({ body: 'x', accountId: null, attachments: [{ assetId: mid.id, altText: '' }] })),
  errOf(drafts.save({ body: 'x', accountId: null, attachments: [{ assetId: photo.id, altText: 'a'.repeat(1001) }] })),
  errOf(drafts.save({ body: 'x', accountId: null, attachments: [{ assetId: '99999999-9999-4999-8999-999999999999', altText: '' }] }))
])).every((e) => e.startsWith('ValidationError')))
check('animated GIF alone is fine', (await drafts.save({ body: 'gif', accountId: null, attachments: [{ assetId: anim.id, altText: 'Colour cycle' }] })).media[0]!.animated === true)
const dup = await drafts.duplicate(d1.id)
check('duplicate shares the attachments', dup.media.map((m) => m.id).join() === d1d.media.map((m) => m.id).join())

// deletion safety & missing files
check('deleting an attached image is refused', (await errOf(assets.remove(webp.id))).includes('attached to 2 drafts'))
const loose = imp.imported.find((a) => a.originalName === 'still.gif')!
await assets.remove(loose.id)
check('unattached image deleted (row + file)', !assetRepo.get(loose.id) && !readdirSync(dir, { recursive: true }).map(String).some((f) => f.includes(loose.id)))
rmSync(assets.fileFor(png.id)!.path)
const afterMissing = await drafts.get(d1.id)
check('missing file reported, not crashed', afterMissing.media.find((m) => m.id === png.id)?.available === false && assets.get(png.id).available === false && assets.fileFor(png.id) === null)
check('saving with a missing attachment explains it', (await errOf(drafts.save({ id: d1.id, body: 'x', accountId: null, attachments: [{ assetId: png.id, altText: '' }] }))).includes('missing from the image folder'))
check('re-importing the same image restores the missing file', (await assets.importFiles([join(FIX, 'pic.png')])).imported.length === 1)
await drafts.remove(dup.id)
check('deleting a draft releases its attachments (assets stay)', assetRepo.get(photo.id) !== null && (assetRepo.get(webp.id)?.usedBy ?? 0) === 1)

// sweep
const month = new Date().toISOString().slice(0, 7)
mkdirSync(join(dir, month), { recursive: true })
const orphan = join(dir, month, '00000000-0000-4000-8000-000000000000.png')
const temp = join(dir, month, 'x.png.abcd.tmp')
writeFileSync(orphan, 'x')
writeFileSync(temp, 'x')
const old = new Date(Date.now() - 2 * 3_600_000)
utimesSync(orphan, old, old)
utimesSync(temp, old, old)
const unkept = (await images.generate(req({ count: 1, format: 'webp', quality: null }), { requestId: rid() })).assets[0]!
db.run("UPDATE image_assets SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = :id", { id: unkept.id })
const swept = await assets.sweep()
check('sweep removes orphan + temp files and week-old unkept results', swept.orphans === 2 && swept.unkept === 1 && !existsSync(orphan) && !existsSync(temp) && !assetRepo.get(unkept.id))
check('sweep never touches kept or attached images', assetRepo.get(photo.id) !== null && assets.fileFor(photo.id) !== null && assetRepo.get(kept.id) !== null)

// persistence
const draftCount = (await drafts.list()).length
db.close()
const db2 = new SqliteDatabase(path).open()
migrate(db2, log)
const repos2 = createSqliteRepositories(db2, { assetExists })
const reopened = (await repos2.drafts.list()).find((d) => d.id === d1.id)!
check('attachments survive reopen', (await repos2.drafts.list()).length === draftCount && reopened.media.length === 2 && reopened.media[1]!.altText === 'A yellow sun')
check('image history survives reopen', new ImageGenerationRepository(db2).list(100).length >= 12)
check('logs hold no prompts or keys', !logged.some((l) => /lighthouse|VALIDKEY|offline mode/i.test(l)))
db2.close()
await mock.close()
console.log(results.join('\n'))
console.log(`\n${results.filter((x) => x.startsWith('FAIL')).length} failed of ${results.length}`)
process.exit(0)
