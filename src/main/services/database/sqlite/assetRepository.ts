import type { ImageMime } from '@shared/config/mediaLimits'
import type { AssetOrigin, AssetQuery } from '@shared/types/images'
import type { SqliteDatabase } from '../driver'
import { str, strOrNull, type Row } from './tableRepository'

export interface AssetRow {
  id: string
  origin: AssetOrigin
  originalName: string
  /** Relative to the asset folder. */
  filePath: string
  mimeType: ImageMime
  width: number
  height: number
  sizeBytes: number
  sha256: string
  animated: boolean
  prompt: string | null
  generationId: string | null
  kept: boolean
  createdAt: string
  usedBy: number
}

export interface AttachmentRow {
  assetId: string
  altText: string
  position: number
}

const SELECT = `SELECT a.*, (SELECT COUNT(*) FROM draft_attachments d WHERE d.asset_id = a.id) AS used_by FROM image_assets a`

const fromRow = (r: Row): AssetRow => ({
  id: str(r.id),
  origin: r.origin as AssetOrigin,
  originalName: str(r.original_name),
  filePath: str(r.file_path),
  mimeType: str(r.mime_type) as ImageMime,
  width: Number(r.width ?? 0),
  height: Number(r.height ?? 0),
  sizeBytes: Number(r.size_bytes ?? 0),
  sha256: str(r.sha256 ?? ''),
  animated: Number(r.animated) === 1,
  prompt: strOrNull(r.prompt),
  generationId: strOrNull(r.image_generation_id),
  kept: Number(r.kept) === 1,
  createdAt: str(r.created_at),
  usedBy: Number(r.used_by ?? 0)
})

const ORDER: Record<NonNullable<AssetQuery['sort']>, string> = {
  newest: 'a.created_at DESC',
  oldest: 'a.created_at ASC',
  largest: 'a.size_bytes DESC',
  name: 'a.original_name COLLATE NOCASE ASC'
}

/** Image metadata (image_assets) and draft attachments (draft_attachments). Files are handled by AssetService. */
export class AssetRepository {
  constructor(private readonly db: SqliteDatabase) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)
  }

  insert(row: Omit<AssetRow, 'usedBy'>): void {
    this.db.run(
      `INSERT INTO image_assets (id, origin, original_name, file_path, mime_type, width, height, size_bytes, sha256, animated, prompt,
         image_generation_id, kept, alt_text, created_at)
       VALUES (:id, :origin, :originalName, :filePath, :mimeType, :width, :height, :sizeBytes, :sha256, :animated, :prompt,
         :generationId, :kept, '', :createdAt)`,
      { ...row }
    )
  }

  get(id: string): AssetRow | null {
    const row = this.db.get<Row>(`${SELECT} WHERE a.id = :id`, { id })
    return row ? fromRow(row) : null
  }

  bySha(sha256: string): AssetRow | null {
    const row = this.db.get<Row>(`${SELECT} WHERE a.sha256 = :sha256`, { sha256 })
    return row ? fromRow(row) : null
  }

  list(query: AssetQuery): AssetRow[] {
    const clauses: string[] = []
    const params: Record<string, string> = {}
    if (!query.includeUnkept) clauses.push('(a.kept = 1 OR EXISTS (SELECT 1 FROM draft_attachments d WHERE d.asset_id = a.id))')
    if (query.origin) (clauses.push('a.origin = :origin'), (params.origin = query.origin))
    if (query.search?.trim()) (clauses.push("(a.original_name LIKE :q ESCAPE '\\' OR a.prompt LIKE :q ESCAPE '\\')"), (params.q = `%${query.search.trim().replace(/[\\%_]/g, '\\$&')}%`))
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return this.db.all<Row>(`${SELECT} ${where} ORDER BY ${ORDER[query.sort ?? 'newest']} LIMIT 2000`, params).map(fromRow)
  }

  byIds(ids: string[]): AssetRow[] {
    if (!ids.length) return []
    const params = Object.fromEntries(ids.map((id, i) => [`i${i}`, id]))
    return this.db.all<Row>(`${SELECT} WHERE a.id IN (${ids.map((_, i) => `:i${i}`).join(', ')})`, params).map(fromRow)
  }

  setKept(id: string, kept: boolean): void {
    this.db.run('UPDATE image_assets SET kept = :kept WHERE id = :id', { id, kept })
  }

  remove(id: string): boolean {
    return this.db.run('DELETE FROM image_assets WHERE id = :id', { id }).changes > 0
  }

  attachments(draftId: string): AttachmentRow[] {
    return this.db
      .all<Row>('SELECT asset_id, alt_text, position FROM draft_attachments WHERE draft_id = :draftId ORDER BY position', { draftId })
      .map((r) => ({ assetId: str(r.asset_id), altText: str(r.alt_text), position: Number(r.position) }))
  }

  replaceAttachments(draftId: string, items: { assetId: string; altText: string }[]): void {
    this.db.run('DELETE FROM draft_attachments WHERE draft_id = :draftId', { draftId })
    items.forEach((item, position) =>
      this.db.run('INSERT INTO draft_attachments (draft_id, asset_id, position, alt_text) VALUES (:draftId, :assetId, :position, :altText)', {
        draftId,
        assetId: item.assetId,
        position,
        altText: item.altText
      })
    )
  }

  /** Generated images nobody kept or attached, older than the cutoff. */
  staleUnkept(beforeIso: string): AssetRow[] {
    return this.db
      .all<Row>(`${SELECT} WHERE a.kept = 0 AND a.created_at < :before AND NOT EXISTS (SELECT 1 FROM draft_attachments d WHERE d.asset_id = a.id)`, { before: beforeIso })
      .map(fromRow)
  }

  knownFiles(): Set<string> {
    return new Set(this.db.all<{ p: string }>('SELECT file_path AS p FROM image_assets').map((r) => r.p))
  }

  stats(): { count: number; bytes: number } {
    const row = this.db.get<{ n: number; b: number | null }>('SELECT COUNT(*) AS n, SUM(size_bytes) AS b FROM image_assets WHERE kept = 1')
    return { count: row?.n ?? 0, bytes: row?.b ?? 0 }
  }
}
