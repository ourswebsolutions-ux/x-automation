import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'

/**
 * Thin adapter over Node's built-in SQLite (bundled with Electron's Node
 * runtime — no native module to rebuild). Everything else in the app talks to
 * this class, so the engine can be swapped without touching repositories.
 */

export type DatabaseErrorCode = 'OPEN' | 'QUERY' | 'CONSTRAINT' | 'BUSY' | 'CORRUPT' | 'INCOMPATIBLE' | 'CLOSED'

export class DatabaseError extends Error {
  constructor(
    message: string,
    readonly code: DatabaseErrorCode,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = 'DatabaseError'
  }
}

type ParamValue = SQLInputValue | boolean | undefined | Date
export type Params = Record<string, ParamValue>
export interface RunResult {
  changes: number
  lastInsertRowid: number
}

/** SQLite result codes we translate (primary code = errcode & 0xff). */
const CODE_MAP: Record<number, DatabaseErrorCode> = { 5: 'BUSY', 6: 'BUSY', 11: 'CORRUPT', 19: 'CONSTRAINT', 26: 'CORRUPT' }

export function toDatabaseError(error: unknown, context: string): DatabaseError {
  if (error instanceof DatabaseError) return error
  const errcode = (error as { errcode?: number }).errcode
  const code = errcode !== undefined ? (CODE_MAP[errcode & 0xff] ?? 'QUERY') : 'QUERY'
  // Never echo parameters — only the engine's own description.
  const detail = (error as { errstr?: string }).errstr ?? (error instanceof Error ? error.message : 'unknown error')
  return new DatabaseError(`${context}: ${detail}`, code, { cause: error })
}

function normalize(params: Params): Record<string, SQLInputValue> {
  const out: Record<string, SQLInputValue> = {}
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) out[key] = null
    else if (typeof value === 'boolean') out[key] = value ? 1 : 0
    else if (value instanceof Date) out[key] = value.toISOString()
    else out[key] = value
  }
  return out
}

export class SqliteDatabase {
  private db: DatabaseSync | null = null
  private readonly statements = new Map<string, StatementSync>()
  private transactionDepth = 0

  constructor(readonly path: string) {}

  open(options: { readOnly?: boolean } = {}): this {
    try {
      this.db = new DatabaseSync(this.path, {
        readOnly: options.readOnly ?? false,
        enableForeignKeyConstraints: true,
        timeout: 5000
      })
      if (!options.readOnly) {
        this.db.exec('PRAGMA journal_mode = WAL')
        this.db.exec('PRAGMA synchronous = NORMAL')
      }
      return this
    } catch (error) {
      this.db = null
      throw toDatabaseError(error, 'Could not open database')
    }
  }

  get isOpen(): boolean {
    return this.db !== null
  }

  /** Raw handle, used only for the online backup API. */
  get handle(): DatabaseSync {
    if (!this.db) throw new DatabaseError('Database is closed', 'CLOSED')
    return this.db
  }

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.handle.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  exec(sql: string): void {
    try {
      this.handle.exec(sql)
    } catch (error) {
      throw toDatabaseError(error, 'Statement failed')
    }
  }

  run(sql: string, params: Params = {}): RunResult {
    try {
      const result = this.statement(sql).run(normalize(params))
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
    } catch (error) {
      throw toDatabaseError(error, 'Write failed')
    }
  }

  get<T>(sql: string, params: Params = {}): T | undefined {
    try {
      return this.statement(sql).get(normalize(params)) as T | undefined
    } catch (error) {
      throw toDatabaseError(error, 'Query failed')
    }
  }

  all<T>(sql: string, params: Params = {}): T[] {
    try {
      return this.statement(sql).all(normalize(params)) as T[]
    } catch (error) {
      throw toDatabaseError(error, 'Query failed')
    }
  }

  pragma<T = unknown>(name: string): T | undefined {
    const row = this.get<Record<string, T>>(`PRAGMA ${name}`)
    return row ? Object.values(row)[0] : undefined
  }

  /**
   * Runs `fn` atomically. Nested calls use savepoints, so services can compose
   * transactional operations freely.
   */
  transaction<T>(fn: () => T): T {
    const depth = this.transactionDepth++
    const savepoint = `sp_${depth}`
    this.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`)
    try {
      const result = fn()
      this.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`)
      return result
    } catch (error) {
      try {
        this.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`)
      } catch {
        // The original error is more useful than a failed rollback.
      }
      throw error
    } finally {
      this.transactionDepth--
    }
  }

  close(): void {
    if (!this.db) return
    this.statements.clear()
    try {
      if (this.transactionDepth === 0) this.db.exec('PRAGMA optimize')
    } catch {
      // Best effort.
    }
    this.db.close()
    this.db = null
  }
}
