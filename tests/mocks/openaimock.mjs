// Mock of the OpenAI REST API following the official API reference:
//   GET  /v1/models            → { object: 'list', data: [{ id, object: 'model', created, owned_by }] }
//   POST /v1/responses         → Response object (status, output[], usage{input_tokens,output_tokens,total_tokens})
//   POST /v1/chat/completions  → ChatCompletion (choices[].message, finish_reason, usage{prompt_tokens,...})
// Errors use the documented envelope { error: { message, type, param, code } }.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
// AXORA_TEST_FIXTURES is set by tests/run-unit.mjs (the mock is bundled into the unit suites there).
const FIX = process.env.AXORA_TEST_FIXTURES ? new URL(`file://${process.env.AXORA_TEST_FIXTURES}/`) : new URL('../fixtures/', import.meta.url)
const fixture = (name) => readFileSync(new URL(name, FIX)).toString('base64')

export const VALID_KEY = 'sk-test-VALIDKEY-0123456789abcdef'


// Generator prompts ask for {"variations": [...]} or {"hashtags": [...]}; answer in kind.
function generatorAnswer(instructions, input, mode, state = {}) {
  if (typeof instructions !== 'string') return null
  const n = Number(/exactly (\d+)/.exec(instructions)?.[1] ?? 1)
  const topic = /<<<\n([^\n]{0,40})/.exec(input ?? '')?.[1] ?? 'post'
  let json = null
  if (instructions.includes('{"hashtags"')) json = JSON.stringify({ hashtags: ['#ProductLaunch', 'offline first', 'Windows', 'productlaunch', '123'] })
  else if (instructions.includes('{"variations"')) json = JSON.stringify({ variations: Array.from({ length: n }, (_, i) => (state.unique ? `Idea #${++state.seq} about ${topic}` : `Variation ${i + 1} about ${topic}`)) })
  if (!json) return null
  if (mode === 'fenced') return 'Here you go:\n```json\n' + json + '\n```'
  if (mode === 'prose') return 'Sure! Here are some ideas for your post about it.'
  if (mode === 'long-result') return JSON.stringify({ variations: ['x'.repeat(400)] })
  return json
}

export function startOpenAiMock(port = 0) {
  const state = {
    mode: 'ok',
    latency: 0,
    models: ['gpt-test-mini', 'gpt-test-large', 'text-embedding-test', 'whisper-test', 'gpt-image-test'],
    log: [],
    rateCount: 0,
    /** unique: every generated variation differs across calls (Idea #N about …). */
    unique: false,
    seq: 0
  }
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'x-request-id': `req_${Math.random().toString(16).slice(2, 10)}`, ...headers })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  }
  const err = (res, status, message, type, code, param = null, headers) => json(res, status, { error: { message, type, param, code } }, headers)

  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      let parsed = null
      try { parsed = body ? JSON.parse(body) : null } catch { parsed = '<<invalid>>' }
      const auth = req.headers.authorization ?? ''
      state.log.push({ method: req.method, path: req.url, auth, idempotency: req.headers['idempotency-key'] ?? null, org: req.headers['openai-organization'] ?? null, project: req.headers['openai-project'] ?? null, body: parsed, at: Date.now() })
      if (state.latency) await new Promise((r) => setTimeout(r, state.latency))
      if (res.destroyed) return
      const m = state.mode
      if (m === 'redirect') { res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' }); return res.end() }
      if (auth !== `Bearer ${VALID_KEY}` && m !== 'keyless') return err(res, 401, `Incorrect API key provided: ${auth.slice(7, 13)}***${auth.slice(-4)}. You can find your API key at https://platform.openai.com/account/api-keys.`, 'invalid_request_error', 'invalid_api_key')
      if (m === 'quota') return err(res, 429, 'You exceeded your current quota, please check your plan and billing details.', 'insufficient_quota', 'insufficient_quota')
      if (m === 'rate') { state.rateCount++; return err(res, 429, 'Rate limit reached for requests', 'requests', 'rate_limit_exceeded', null, { 'retry-after': '1' }) }
      if (m === 'rate-once' && state.rateCount++ === 0) return err(res, 429, 'Rate limit reached for requests', 'requests', 'rate_limit_exceeded', null, { 'retry-after': '1' })
      if (m === 'server') return err(res, 500, 'The server had an error while processing your request.', 'server_error', null)
      if (m === 'malformed') return json(res, 200, '{"object":"list","data":[', {})
      if (m === 'forbidden') return err(res, 403, 'Project does not have access to model', 'invalid_request_error', 'model_not_found_or_forbidden')

      const path = (req.url ?? '').replace(/\?.*$/, '')
      if (req.method === 'GET' && path === '/v1/models') {
        if (m === 'no-models') return json(res, 404, { error: { message: 'Not found', type: 'invalid_request_error', code: null } })
        return json(res, 200, { object: 'list', data: state.models.map((id) => ({ id, object: 'model', created: 1700000000, owned_by: 'system' })) })
      }
      const model = parsed?.model
      const known = state.models.includes(model)
      if (req.method === 'POST' && (path === '/v1/responses' || path === '/v1/chat/completions') && !known) {
        return err(res, 404, `The model \`${model}\` does not exist or you do not have access to it.`, 'invalid_request_error', 'model_not_found')
      }
      if (req.method === 'POST' && path === '/v1/images/generations') {
        if (!known) return err(res, 404, `The model \`${model}\` does not exist or you do not have access to it.`, 'invalid_request_error', 'model_not_found')
        if (m === 'img-bad-size') return err(res, 400, "Invalid value: '9x9'. Supported values are: '1024x1024'.", 'invalid_request_error', 'invalid_value', 'size')
        if (m === 'img-empty') return json(res, 200, { created: 1700000000, data: [] })
        const n = parsed.n ?? 1
        const fmt = parsed.output_format ?? 'png'
        const item = () =>
          m === 'img-url' ? { url: 'http://images.example.test/result.png' }
          : m === 'img-garbage' ? { b64_json: Buffer.from('this is not an image at all, sorry').toString('base64') }
          : { b64_json: fixture(fmt === 'jpeg' ? 'gen.jpg' : fmt === 'webp' ? 'gen.webp' : 'gen.png'), ...(String(model).startsWith('dall-e-3') ? { revised_prompt: 'A revised prompt' } : {}) }
        return json(res, 200, {
          created: 1700000000,
          data: Array.from({ length: n }, item),
          ...(String(model).startsWith('gpt-image') ? { output_format: fmt, size: parsed.size, quality: parsed.quality ?? 'medium', usage: { input_tokens: 21, output_tokens: 1056, total_tokens: 1077, input_tokens_details: { text_tokens: 21, image_tokens: 0 } } } : {})
        })
      }
      if (req.method === 'POST' && path === '/v1/responses') {
        if (m === 'unsupported-temp' && parsed.temperature !== undefined) return err(res, 400, "Unsupported parameter: 'temperature' is not supported with this model.", 'invalid_request_error', 'unsupported_parameter', 'temperature')
        const incomplete = m === 'incomplete'
        const text = generatorAnswer(parsed.instructions, parsed.input, m, state) ?? `Echo: ${String(parsed.input).slice(0, 40)}`
        return json(res, 200, {
          id: 'resp_test123', object: 'response', created_at: 1700000000, model: `${model}-2026-01-01`, status: incomplete ? 'incomplete' : 'completed',
          incomplete_details: incomplete ? { reason: 'max_output_tokens' } : null, error: null,
          output: [{ type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }],
          usage: m === 'no-usage' ? null : { input_tokens: 12, output_tokens: 7, total_tokens: 19, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }
        })
      }
      if (req.method === 'POST' && path === '/v1/chat/completions') {
        const user = (parsed.messages ?? []).find((x) => x.role === 'user')?.content ?? ''
        const system = (parsed.messages ?? []).find((x) => x.role === 'system')?.content
        const gen = generatorAnswer(system, user, m, state)
        return json(res, 200, {
          id: 'chatcmpl-1', object: 'chat.completion', created: 1700000000, model,
          choices: [{ index: 0, message: { role: 'assistant', content: gen ?? `Chat: ${String(user).slice(0, 40)}` }, finish_reason: m === 'incomplete' ? 'length' : 'stop' }],
          ...(m === 'no-usage' ? {} : { usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 } })
        })
      }
      return err(res, 404, 'Unknown endpoint', 'invalid_request_error', null)
    })
  })
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => resolve({ state, port: server.address().port, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }) }))
  )
}
