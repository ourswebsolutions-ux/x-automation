import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import type { ProxyScheme, ProxyTest } from '@shared/types/proxies'

export interface ProxyEndpoint {
  scheme: ProxyScheme
  host: string
  port: number
  username: string | null
  password: string | null
}

export interface TestTarget {
  host: string
  port: number
  /** Complete a TLS handshake (certificate verified) through the tunnel. */
  tls: boolean
}

export const DEFAULT_TEST_TARGET: TestTarget = { host: 'example.com', port: 443, tls: true }

class ProxyTestError extends Error {}

const SOCKS_REPLY: Record<number, string> = {
  1: 'The SOCKS server reported a general failure.',
  2: 'The SOCKS server’s rules do not allow this connection.',
  3: 'The SOCKS server could not reach the network.',
  4: 'The SOCKS server could not reach the test host.',
  5: 'The test host refused the connection made by the SOCKS server.',
  6: 'The connection through the SOCKS server expired.',
  7: 'The SOCKS server does not support CONNECT.',
  8: 'The SOCKS server does not support this address type.'
}

const NET_ERRORS: Record<string, string> = {
  ECONNREFUSED: 'Nothing is accepting connections at that proxy address.',
  ENOTFOUND: 'The proxy’s host name could not be found.',
  EAI_AGAIN: 'The proxy’s host name could not be resolved right now.',
  ECONNRESET: 'The proxy closed the connection.',
  EHOSTUNREACH: 'The proxy’s address is unreachable.',
  ENETUNREACH: 'The network is unreachable.',
  ETIMEDOUT: 'The connection to the proxy timed out.'
}

/** Reads from a socket until `done` says enough has arrived. */
function readUntil(socket: Socket, done: (data: Buffer) => number | null): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk])
      if (data.length > 16_384) return finish(new ProxyTestError('The proxy sent an unexpectedly long reply.'))
      const used = done(data)
      if (used !== null) finish(null, data.subarray(0, used))
    }
    const onEnd = () => finish(new ProxyTestError('The proxy closed the connection before answering.'))
    const finish = (error: Error | null, value?: Buffer) => {
      socket.off('data', onData)
      socket.off('end', onEnd)
      socket.off('error', onErr)
      if (error) reject(error)
      else resolve(value!)
    }
    const onErr = (error: Error) => finish(error)
    socket.on('data', onData)
    socket.once('end', onEnd)
    socket.once('error', onErr)
  })
}

async function httpConnect(socket: Socket, proxy: ProxyEndpoint, target: TestTarget): Promise<void> {
  const auth = proxy.username ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64')}\r\n` : ''
  socket.write(`CONNECT ${target.host}:${target.port} HTTP/1.1\r\nHost: ${target.host}:${target.port}\r\n${auth}\r\n`)
  const head = (await readUntil(socket, (d) => {
    const i = d.indexOf('\r\n\r\n')
    return i >= 0 ? i + 4 : null
  })).toString('latin1')
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0)
  if (status === 200) return
  if (status === 407) throw new ProxyTestError(proxy.username ? 'The proxy rejected the username or password (HTTP 407).' : 'The proxy requires a username and password (HTTP 407).')
  if (!status) throw new ProxyTestError('The proxy did not answer like an HTTP proxy. Check the proxy type.')
  throw new ProxyTestError(`The proxy refused the tunnel (HTTP ${status}).`)
}

async function socks5Connect(socket: Socket, proxy: ProxyEndpoint, target: TestTarget): Promise<void> {
  const useAuth = Boolean(proxy.username)
  socket.write(Buffer.from(useAuth ? [5, 2, 0, 2] : [5, 1, 0]))
  const greet = await readUntil(socket, (d) => (d.length >= 2 ? 2 : null))
  if (greet[0] !== 5) throw new ProxyTestError('The proxy did not answer like a SOCKS5 server. Check the proxy type.')
  if (greet[1] === 0xff) throw new ProxyTestError(useAuth ? 'The SOCKS server accepts none of the offered sign-in methods.' : 'The SOCKS server requires a username and password.')
  if (greet[1] === 2) {
    if (!useAuth) throw new ProxyTestError('The SOCKS server requires a username and password.')
    const u = Buffer.from(proxy.username!, 'utf8')
    const p = Buffer.from(proxy.password ?? '', 'utf8')
    if (u.length > 255 || p.length > 255) throw new ProxyTestError('SOCKS5 usernames and passwords can be at most 255 bytes.')
    socket.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]))
    const reply = await readUntil(socket, (d) => (d.length >= 2 ? 2 : null))
    if (reply[1] !== 0) throw new ProxyTestError('The SOCKS server rejected the username or password.')
  } else if (greet[1] !== 0) {
    throw new ProxyTestError('The SOCKS server asked for an unsupported sign-in method.')
  }
  const host = Buffer.from(target.host, 'utf8')
  socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, Buffer.from([target.port >> 8, target.port & 0xff])]))
  const head = await readUntil(socket, (d) => {
    if (d.length < 5) return null
    const len = d[3] === 1 ? 10 : d[3] === 4 ? 22 : d[3] === 3 ? 7 + d[4]! : -1
    if (len < 0) return d.length
    return d.length >= len ? len : null
  })
  if (head[0] !== 5) throw new ProxyTestError('The SOCKS server sent an invalid reply.')
  if (head[1] !== 0) throw new ProxyTestError(SOCKS_REPLY[head[1]!] ?? `The SOCKS server refused the connection (code ${head[1]}).`)
}

/**
 * A real connectivity test: open the proxy connection, ask it for a tunnel to
 * the test host (HTTP CONNECT or SOCKS5 CONNECT), and — for TLS targets —
 * complete a certificate-verified TLS handshake through it. Latency covers the
 * whole sequence. The password is used only on the wire; errors never echo it.
 */
export async function testProxy(proxy: ProxyEndpoint, target: TestTarget = DEFAULT_TEST_TARGET, timeoutMs = 15_000): Promise<ProxyTest> {
  const started = Date.now()
  const label = `${target.host}:${target.port}`
  let socket: Socket | null = null
  let tunnelTls: TLSSocket | null = null
  const timer = setTimeout(() => socket?.destroy(new ProxyTestError(`No answer within ${Math.round(timeoutMs / 1000)} s.`)), timeoutMs)
  try {
    socket = await new Promise<Socket>((resolve, reject) => {
      const s: Socket =
        proxy.scheme === 'https'
          ? tlsConnect({ host: proxy.host, port: proxy.port, servername: proxy.host.includes(':') ? undefined : proxy.host }, () => resolve(s))
          : netConnect({ host: proxy.host, port: proxy.port }, () => resolve(s))
      socket = s
      s.once('error', reject)
    })
    socket.removeAllListeners('error')
    socket.on('error', () => undefined)
    if (proxy.scheme === 'socks5') await socks5Connect(socket, proxy, target)
    else await httpConnect(socket, proxy, target)
    if (!target.tls) return { ok: true, testedAt: new Date().toISOString(), latencyMs: Date.now() - started, error: null, verified: 'tunnel', target: label }
    tunnelTls = await new Promise<TLSSocket>((resolve, reject) => {
      const t = tlsConnect({ socket: socket!, servername: target.host }, () => resolve(t))
      t.once('error', reject)
    })
    return { ok: true, testedAt: new Date().toISOString(), latencyMs: Date.now() - started, error: null, verified: 'tls', target: label }
  } catch (error) {
    const code = (error as { code?: string }).code
    const message =
      error instanceof ProxyTestError
        ? error.message
        : code && NET_ERRORS[code]
          ? NET_ERRORS[code]!
          : code?.startsWith('ERR_TLS') || code?.includes('CERT')
            ? 'The TLS handshake through the proxy failed (certificate problem or the proxy altered the connection).'
            : 'The connection through the proxy failed.'
    return { ok: false, testedAt: new Date().toISOString(), latencyMs: null, error: message, verified: null, target: label }
  } finally {
    clearTimeout(timer)
    tunnelTls?.destroy()
    socket?.destroy()
  }
}
