import { createServer } from 'node:http'
import { ActivationError } from './activation.mjs'

const MAX_BODY_BYTES = 4096

function readJson(request) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(request.headers['content-type'] ?? '')) return reject(new ActivationError(415, 'invalid_request', 'JSON is required.'))
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new ActivationError(413, 'invalid_request', 'Request too large.'))
        return
      }
      chunks.push(chunk)
    })
    request.on('error', reject)
    request.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('not an object')
        resolve(body)
      } catch {
        reject(new ActivationError(400, 'invalid_request', 'Invalid JSON.'))
      }
    })
  })
}

/** With TRUST_PROXY=1 the last X-Forwarded-For entry is the one our own proxy appended. */
function clientIp(request, trustProxy) {
  const forwarded = request.headers['x-forwarded-for']
  if (trustProxy && typeof forwarded === 'string') {
    const last = forwarded.split(',').at(-1)?.trim()
    if (last) return last
  }
  return request.socket.remoteAddress ?? 'unknown'
}

export function createApp(service, { trustProxy = false, onError = () => {} } = {}) {
  const routes = {
    'GET /healthz': () => ({ ok: true }),
    'GET /v1/plans': () => ({ plans: service.plans() }),
    'POST /v1/activation/request': (body, ip) => service.requestOtp({ activationId: body.activationId, deviceKey: body.deviceKey, plan: body.plan, ip }),
    'POST /v1/activation/verify': (body, ip) => service.verifyOtp({ activationId: body.activationId, deviceKey: body.deviceKey, plan: body.plan, otp: body.otp, ip }),
    'POST /v1/subscription/status': (body, ip) => service.status({ activationId: body.activationId, deviceKey: body.deviceKey, ip })
  }

  const server = createServer(async (request, response) => {
    const reply = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      response.end(JSON.stringify(body))
    }
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    const route = routes[`${request.method} ${path}`]
    if (!route) return reply(404, { error: { code: 'not_found', message: 'Not found.' } })
    try {
      const body = request.method === 'POST' ? await readJson(request) : {}
      reply(200, await route(body, clientIp(request, trustProxy)))
    } catch (error) {
      if (error instanceof ActivationError) return reply(error.status, { error: { code: error.code, message: error.message } })
      onError(error)
      reply(500, { error: { code: 'internal', message: 'Something went wrong.' } })
    }
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  return server
}
