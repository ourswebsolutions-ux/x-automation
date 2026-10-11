import { writeFile } from 'node:fs/promises'
import type { LogEntry, LogLevel, LogMeta, LogQuery } from '@shared/types/system'
import type { LogRepository } from '../database/repositories'

type Listener = (entry: LogEntry) => void

/**
 * Patterns that look like credentials. Anything matching is masked before it
 * reaches the database, the renderer, or an export.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g, // OpenAI-style keys
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(api[_-]?key|token|secret|password|cookie|authorization)\s*[:=]\s*["']?[^\s"',;]+/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g // JWTs
]

export function redact(text: string): string {
  return SECRET_PATTERNS.reduce(
    (acc, pattern) =>
      acc.replace(pattern, (match) => {
        const sep = match.search(/[:=\s]/)
        return sep > 0 && !match.startsWith('sk-') && !match.startsWith('eyJ') ? `${match.slice(0, sep + 1)}[redacted]` : '[redacted]'
      }),
    text
  )
}

const SENSITIVE_KEY = /pass|secret|token|api.?key|auth|cookie|session|credential|private/i
const MAX_META_KEYS = 20
const MAX_MESSAGE = 2000

/** Drops sensitive keys, redacts values, and keeps only primitive types. */
export function sanitizeMeta(meta: Record<string, unknown> | undefined): LogMeta | null {
  if (!meta) return null
  const out: LogMeta = {}
  for (const [key, value] of Object.entries(meta).slice(0, MAX_META_KEYS)) {
    const safeKey = key.slice(0, 40)
    if (SENSITIVE_KEY.test(key)) out[safeKey] = '[redacted]'
    else if (typeof value === 'string') out[safeKey] = redact(value).slice(0, 300)
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[safeKey] = value
  }
  return Object.keys(out).length ? out : null
}

const BUFFER_SIZE = 500

/**
 * Structured logger. Entries are kept in a small in-memory ring (so logging
 * works before the database opens) and persisted to SQLite once attached.
 */
export class Logger {
  private readonly recent: LogEntry[] = []
  private readonly pending: Omit<LogEntry, 'id'>[] = []
  private readonly listeners = new Set<Listener>()
  private store: LogRepository | null = null
  private fallbackId = -1

  scope(scope: string) {
    return {
      debug: (message: string, meta?: Record<string, unknown>) => this.write('debug', scope, message, meta),
      info: (message: string, meta?: Record<string, unknown>) => this.write('info', scope, message, meta),
      success: (message: string, meta?: Record<string, unknown>) => this.write('success', scope, message, meta),
      warn: (message: string, meta?: Record<string, unknown>) => this.write('warning', scope, message, meta),
      error: (message: string, error?: unknown, meta?: Record<string, unknown>) =>
        this.write('error', scope, error instanceof Error ? `${message}: ${error.message}` : message, meta)
    }
  }

  /** Connects persistent storage and flushes anything logged before it existed. */
  attachStore(store: LogRepository): void {
    this.store = store
    for (const entry of this.pending.splice(0)) this.persist(entry)
  }

  detachStore(): void {
    this.store = null
  }

  write(level: LogLevel, scope: string, message: string, meta?: Record<string, unknown>): LogEntry {
    const base: Omit<LogEntry, 'id'> = {
      at: new Date().toISOString(),
      level,
      scope: scope.slice(0, 40),
      message: redact(message).slice(0, MAX_MESSAGE),
      meta: sanitizeMeta(meta)
    }
    const id = this.store ? this.persist(base) : (this.pending.push(base), this.fallbackId--)
    const entry: LogEntry = { ...base, id }
    this.recent.push(entry)
    if (this.recent.length > BUFFER_SIZE) this.recent.shift()
    this.listeners.forEach((listener) => listener(entry))
    return entry
  }

  private persist(entry: Omit<LogEntry, 'id'>): number {
    try {
      return this.store?.insert(entry) ?? this.fallbackId--
    } catch (error) {
      // Never recurse into the logger when storage fails.
      console.error('[logger] could not persist log entry', (error as Error).message)
      return this.fallbackId--
    }
  }

  query(query: LogQuery = {}): LogEntry[] {
    if (this.store) {
      try {
        return this.store.query(query)
      } catch {
        // Fall through to the in-memory ring.
      }
    }
    const search = query.search?.trim().toLowerCase()
    return this.recent
      .filter((e) => (!query.levels?.length || query.levels.includes(e.level)) && (!search || `${e.scope} ${e.message}`.toLowerCase().includes(search)))
      .slice(-(query.limit ?? 500))
      .reverse()
  }

  clear(): number {
    this.recent.length = 0
    return this.store?.clear() ?? 0
  }

  prune(retentionDays: number): number {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString()
    return this.store?.pruneBefore(cutoff) ?? 0
  }

  /** Writes a sanitized export. Content is redacted again defensively. */
  async exportTo(path: string, format: 'text' | 'json', query: LogQuery = {}): Promise<number> {
    const entries = this.query({ ...query, limit: query.limit ?? 5000 }).reverse()
    const clean = entries.map((e) => ({ ...e, message: redact(e.message), meta: sanitizeMeta(e.meta ?? undefined) }))
    const body =
      format === 'json'
        ? JSON.stringify({ exportedAt: new Date().toISOString(), sanitized: true, entries: clean }, null, 2)
        : [
            `# X Auto log export — ${new Date().toISOString()}`,
            '# Sanitized: credentials and tokens are redacted.',
            ...clean.map(
              (e) => `${e.at} ${e.level.toUpperCase().padEnd(7)} [${e.scope}] ${e.message}${e.meta ? ` ${JSON.stringify(e.meta)}` : ''}`
            )
          ].join('\n')
    await writeFile(path, body, 'utf8')
    return clean.length
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export type ScopedLogger = ReturnType<Logger['scope']>
