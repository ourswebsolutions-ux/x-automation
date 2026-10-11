import { isIP } from 'node:net'
import type { ProxyScheme } from '@shared/types/proxies'

export interface ParsedProxy {
  scheme: ProxyScheme
  host: string
  port: number
  username: string | null
  password: string | null
  label: string | null
  notes: string
}

const SCHEMES: Record<string, ProxyScheme> = { http: 'http', https: 'https', socks5: 'socks5', socks5h: 'socks5', socks: 'socks5' }
const HOSTNAME = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/

export function validHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '')
  return isIP(h) !== 0 || HOSTNAME.test(h)
}

const portOf = (value: string | undefined): number | null => {
  if (!value || !/^\d{1,5}$/.test(value)) return null
  const n = Number(value)
  return n >= 1 && n <= 65535 ? n : null
}

/** "[::1]:8080" or "host:8080" → [host, port] */
function hostPort(text: string): [string, number] | null {
  const m = /^\[([0-9A-Fa-f:.]+)\]:(\d{1,5})$/.exec(text) ?? /^([^:\s@]+):(\d{1,5})$/.exec(text)
  if (!m) return null
  const port = portOf(m[2])
  return port && validHost(m[1]!) ? [m[1]!, port] : null
}

const creds = (text: string): [string, string] | null => {
  const i = text.indexOf(':')
  return i > 0 ? [decodeURIComponent(text.slice(0, i)), decodeURIComponent(text.slice(i + 1))] : null
}

/**
 * One proxy per line, in the formats IX Browser's SDK lists
 * ("ip:port", "ip:port:username:password", "username:password@ip:port",
 * "ip:port@username:password", "username:password:ip:port") plus
 * scheme://[user:pass@]host:port. Returns a reason string when invalid.
 */
export function parseProxyLine(raw: string, defaultScheme: ProxyScheme = 'http'): ParsedProxy | string {
  const line = raw.trim()
  if (!line) return 'Empty line.'
  let scheme = defaultScheme
  let rest = line
  const schemeMatch = /^([a-z0-9]+):\/\//i.exec(line)
  if (schemeMatch) {
    const s = SCHEMES[schemeMatch[1]!.toLowerCase()]
    if (!s) return `Unsupported proxy type “${schemeMatch[1]}”. Use http, https or socks5.`
    scheme = s
    rest = line.slice(schemeMatch[0].length).replace(/\/$/, '')
  }
  const base = { scheme, label: null, notes: '' }
  if (rest.includes('@')) {
    const at = rest.lastIndexOf('@')
    const left = rest.slice(0, at)
    const right = rest.slice(at + 1)
    const hpRight = hostPort(right)
    if (hpRight) {
      const c = creds(left)
      return c ? { ...base, host: hpRight[0], port: hpRight[1], username: c[0] || null, password: c[1] || null } : 'Credentials must be written as username:password.'
    }
    const hpLeft = hostPort(left)
    const c = creds(right)
    if (hpLeft && c) return { ...base, host: hpLeft[0], port: hpLeft[1], username: c[0] || null, password: c[1] || null }
    return 'Couldn’t read host and port.'
  }
  const hp = hostPort(rest)
  if (hp) return { ...base, host: hp[0], port: hp[1], username: null, password: null }
  const parts = rest.split(':')
  if (parts.length >= 4) {
    // host:port:user:pass — or user:pass:host:port when only the last part is a port.
    if (portOf(parts[1]) && validHost(parts[0]!)) return { ...base, host: parts[0]!, port: portOf(parts[1])!, username: parts[2] || null, password: parts.slice(3).join(':') || null }
    const p = portOf(parts[parts.length - 1])
    const h = parts[parts.length - 2]!
    if (p && validHost(h)) return { ...base, host: h, port: p, username: parts[0] || null, password: parts.slice(1, -2).join(':') || null }
  }
  return 'Couldn’t read this line. Use host:port, host:port:user:pass, user:pass@host:port or scheme://user:pass@host:port.'
}

/** Minimal RFC 4180 CSV parsing (quoted fields, doubled quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"', i++)
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"' && field === '') quoted = true
    else if (c === ',') (row.push(field), (field = ''))
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      if (row.some((f) => f.trim())) rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  row.push(field)
  if (row.some((f) => f.trim())) rows.push(row)
  return rows
}

export const CSV_COLUMNS = ['label', 'type', 'host', 'port', 'username', 'password', 'notes'] as const

/** CSV rows with a header (label,type,host,port,username,password,notes — password optional). */
export function parseProxyCsv(text: string): { line: number; result: ParsedProxy | string }[] {
  const rows = parseCsv(text)
  if (!rows.length) return []
  const header = rows[0]!.map((h) => h.trim().toLowerCase())
  const col = (name: string) => header.indexOf(name)
  if (col('host') < 0 || col('port') < 0) return [{ line: 1, result: 'The CSV needs a header row with at least “host” and “port” columns.' }]
  return rows.slice(1).map((r, i) => {
    const get = (name: string) => (col(name) >= 0 ? (r[col(name)] ?? '').trim() : '')
    const typeText = get('type').toLowerCase() || 'http'
    const scheme = SCHEMES[typeText]
    const port = portOf(get('port'))
    const host = get('host').replace(/^\[|\]$/g, '')
    let result: ParsedProxy | string
    if (!scheme) result = `Unsupported proxy type “${typeText}”.`
    else if (!validHost(host)) result = 'Invalid host.'
    else if (!port) result = 'Port must be 1–65535.'
    else result = { scheme, host, port, username: get('username') || null, password: get('password') || null, label: get('label') || null, notes: get('notes').slice(0, 1000) }
    return { line: i + 2, result }
  })
}

const csvField = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)

/** Exports never include passwords. */
export function toCsv(rows: { label: string; scheme: string; host: string; port: number; username: string | null; notes: string }[]): string {
  return [
    ['label', 'type', 'host', 'port', 'username', 'notes'].join(','),
    ...rows.map((r) => [r.label, r.scheme, r.host.includes(':') ? `[${r.host}]` : r.host, String(r.port), r.username ?? '', r.notes].map(csvField).join(','))
  ].join('\r\n')
}

export function toTxt(rows: { scheme: string; host: string; port: number; username: string | null }[]): string {
  return rows
    .map((r) => `${r.scheme}://${r.username ? `${encodeURIComponent(r.username)}@` : ''}${r.host.includes(':') ? `[${r.host}]` : r.host}:${r.port}`)
    .join('\n')
}
