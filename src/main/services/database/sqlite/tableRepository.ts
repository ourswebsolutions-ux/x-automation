import type { Id } from '@shared/types/domain'
import type { Params, SqliteDatabase } from '../driver'
import type { Repository } from '../repositories'

export type Row = Record<string, unknown>

export interface RowMapper<T> {
  toRow(item: T): Params
  fromRow(row: Row): T
}

/**
 * Generic id-keyed repository. Table and column names come from code, never
 * from input; all values are bound parameters.
 */
export class TableRepository<T extends { id: Id }> implements Repository<T> {
  private readonly upsertSql: string

  constructor(
    protected readonly db: SqliteDatabase,
    protected readonly table: string,
    protected readonly columns: readonly string[],
    protected readonly mapper: RowMapper<T>,
    protected readonly orderBy = 'rowid'
  ) {
    const updates = columns.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`)
    this.upsertSql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((c) => `:${c}`).join(', ')})
      ON CONFLICT(id) DO UPDATE SET ${updates.join(', ')}`
  }

  async list(): Promise<T[]> {
    return this.db.all<Row>(`SELECT * FROM ${this.table} ORDER BY ${this.orderBy}`).map((row) => this.mapper.fromRow(row))
  }

  async get(id: Id): Promise<T | null> {
    const row = this.db.get<Row>(`SELECT * FROM ${this.table} WHERE id = :id`, { id })
    return row ? this.mapper.fromRow(row) : null
  }

  async upsert(item: T): Promise<T> {
    this.db.run(this.upsertSql, this.mapper.toRow(item))
    return item
  }

  async remove(id: Id): Promise<void> {
    this.db.run(`DELETE FROM ${this.table} WHERE id = :id`, { id })
  }

  async count(): Promise<number> {
    return this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${this.table}`)?.n ?? 0
  }
}

export const str = (value: unknown): string => String(value)
export const strOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))
export const parseJson = <T>(value: unknown, fallback: T): T => {
  try {
    return typeof value === 'string' ? (JSON.parse(value) as T) : fallback
  } catch {
    return fallback
  }
}
