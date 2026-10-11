// Mock of the IX Browser Local API V2, following the contract used by the official
// client (ixspyinc/ixbrowser-local-api-python): POST /api/v2/<action>, JSON body,
// envelope { error: { code, message }, data }, paginated data { total, data }.
import { createServer } from 'node:http'

export function startMock(port = 0) {
  const state = {
    mode: 'ok',
    latency: 0,
    profiles: [],
    openedApi: new Set(),
    openedClient: new Set(),
    log: [],
    flakyCounter: 0,
    /** Returned as debugging_address by profile-open (the documented field); null omits it. */
    debuggingAddress: '127.0.0.1:9222',
    proxyUpdates: [],
    /** Per-profile debugging_address overrides (profile_id → host:port). */
    debuggingAddresses: {}
  }
  state.profiles = Array.from({ length: 237 }, (_, i) => makeProfile(i + 1))

  const send = (res, status, body, raw = false) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(raw ? body : JSON.stringify(body))
  }
  const ok = (data) => (data === undefined ? { error: { code: 0, message: 'success' } } : { error: { code: 0, message: 'success' }, data })

  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      const action = (req.url || '').replace(/^\/api\/v2\//, '')
      let params = null
      try { params = body ? JSON.parse(body) : null } catch { params = '<<invalid json>>' }
      state.log.push({ method: req.method, url: req.url, contentType: req.headers['content-type'], params, at: Date.now() })
      if (state.latency) await new Promise((r) => setTimeout(r, state.latency))
      if (res.destroyed) return
      if (req.method !== 'POST' || !req.url?.startsWith('/api/v2/')) return send(res, 404, { message: 'Not Found' })
      const m = state.mode
      if (m === 'not-found') return send(res, 404, { message: 'Not Found' })
      if (m === 'http500') return send(res, 500, { message: 'oops' })
      if (m === 'flaky' && action !== 'profile-open' && state.flakyCounter++ % 2 === 0) return send(res, 503, { message: 'busy' })
      if (m === 'flaky' && action === 'profile-open') return send(res, 503, { message: 'busy' })
      if (m === 'bad-json') return send(res, 200, '{"error": {"code": 0}, "data": [', true)
      if (m === 'no-envelope') return send(res, 200, { success: true, data: [] })
      if (m === 'api-error') return send(res, 200, { error: { code: 1009, message: 'Local API is not enabled. token=abc123secretvalue' } })
      switch (action) {
        case 'profile-list': {
          const page = params?.page ?? 1
          const limit = params?.limit ?? 10
          let list = state.profiles
          if (m === 'bad-profile') list = list.map((p, i) => (i === 3 ? { ...p, profile_id: 'four' } : p))
          let items = list.slice((page - 1) * limit, page * limit)
          if (m === 'dupes' && page === 2) items = [list[5], ...items.slice(1)] // repeats id 6 from page 1
          return send(res, 200, ok({ total: list.length, data: items }))
        }
        case 'profile-opened-list':
          return send(res, 200, ok([...state.openedApi].map((id) => ({ profile_id: id }))))
        case 'native-client-profile-opened-list':
          if (m === 'no-native') return send(res, 404, { message: 'Not Found' })
          return send(res, 200, ok([...state.openedClient]))
        case 'profile-open': {
          if (m === 'open-fails') return send(res, 200, { error: { code: 2007, message: 'Profile is being used by another member' } })
          const id = params?.profile_id
          if (!state.profiles.some((p) => p.profile_id === id)) return send(res, 200, { error: { code: 1001, message: 'Profile does not exist' } })
          state.openedApi.add(id)
          return send(res, 200, ok({ profile_id: id, ...((state.debuggingAddresses[id] ?? state.debuggingAddress) ? { debugging_address: state.debuggingAddresses[id] ?? state.debuggingAddress } : {}), webdriver: 'C:\\\\ixBrowser\\\\chromedriver.exe' }))
        }
        case 'profile-update-proxy-for-custom-proxy': {
          if (m === 'proxy-fails') return send(res, 200, { error: { code: 1008, message: 'Proxy check failed' } })
          const id = params?.profile_id
          if (!state.profiles.some((p) => p.profile_id === id)) return send(res, 200, { error: { code: 1001, message: 'Profile does not exist' } })
          state.proxyUpdates.push(params)
          return send(res, 200, ok())
        }
        case 'profile-close':
          state.openedApi.delete(params?.profile_id)
          state.openedClient.delete(params?.profile_id)
          return send(res, 200, ok())
        default:
          return send(res, 404, { message: 'Not Found' })
      }
    })
  })
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => resolve({ server, state, port: server.address().port, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }) }))
  )
}

export function makeProfile(id, overrides = {}) {
  return {
    profile_id: id,
    name: `Profile ${String(id).padStart(3, '0')}`,
    site_url: 'https://www.ixbrowser.com',
    group_id: (id % 4) + 1,
    group_name: ['Brands', 'Community', 'Tech', 'Testing'][id % 4],
    note: `Seat ${id}`,
    tag: ['a', 'b'],
    // Sensitive fields that must never be stored or shown:
    username: `user${id}@example.com`,
    password: `pw-${id}-SECRETPW`,
    cookie: `sid=SECRETCOOKIE${id}`,
    proxy_password: 'SECRETPROXY',
    ...overrides
  }
}
