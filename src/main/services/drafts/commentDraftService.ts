import { randomUUID } from 'node:crypto'
import { BULK_MAX_CHARS } from '@shared/lib/bulkParse'
import type { BulkSaveInput, BulkSaveResult, CommentDraft, Id } from '@shared/types/domain'
import type { SqliteDatabase } from '../database/driver'
import { NotFoundError, ValidationError } from '../errors'
import type { ScopedLogger } from '../logging/logger'
import { parsePostUrl } from '../publishing/postUrl'
import { bulkSave } from './bulk'

interface Row {
  id: string
  body: string
  target_url: string | null
  used_at: string | null
  created_at: string
  updated_at: string
}

const toComment = (r: Row): CommentDraft => ({ id: r.id, body: r.body, targetUrl: r.target_url, usedAt: r.used_at, createdAt: r.created_at, updatedAt: r.updated_at })

/**
 * Saved comments for campaigns (bulk comments). A comment is posted only as a reply to a post you
 * choose — its own target, or a post selected in the campaign; a target is never made up. Nothing
 * here posts anything.
 */
export class CommentDraftService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly log: ScopedLogger
  ) {}

  list(): CommentDraft[] {
    return this.db.all<Row>('SELECT * FROM comment_drafts ORDER BY created_at DESC, position ASC').map(toComment)
  }

  /** In the given order; ids that no longer exist are left out. */
  byIds(ids: Id[]): CommentDraft[] {
    const byId = new Map(this.db.all<Row>('SELECT * FROM comment_drafts WHERE id IN (SELECT value FROM json_each(:ids))', { ids: JSON.stringify(ids) }).map((r) => [r.id, toComment(r)]))
    return [...new Set(ids)].map((id) => byId.get(id)).filter((c): c is CommentDraft => Boolean(c))
  }

  /** Bulk comments: each valid item is saved as its own comment, in one transaction (see bulk.ts). */
  saveMany(input: BulkSaveInput): BulkSaveResult {
    const target = this.target(input.targetUrl ?? null)
    const existing = this.db.all<{ body: string }>('SELECT body FROM comment_drafts').map((r) => r.body)
    const at = new Date().toISOString()
    const result = bulkSave(this.db, 'comment', input, existing, (body, index) => {
      const id = randomUUID()
      this.db.run('INSERT INTO comment_drafts (id, body, target_url, position, used_at, created_at, updated_at) VALUES (:id, :body, :target, :position, NULL, :at, :at)', { id, body, target, position: index, at })
      return id
    })
    if (!result.repeated) this.log.info(`Bulk save: ${result.saved.length} comments saved, ${result.skipped.length} skipped${target ? ', with a target post' : ''}`)
    return result
  }

  update(id: Id, patch: { body?: string; targetUrl?: string | null }): CommentDraft {
    const row = this.db.get<Row>('SELECT * FROM comment_drafts WHERE id = :id', { id })
    if (!row) throw new NotFoundError('That comment no longer exists.')
    const body = patch.body === undefined ? row.body : patch.body.trim()
    if (!body) throw new ValidationError('A comment needs some text.')
    if (body.length > BULK_MAX_CHARS.comment) throw new ValidationError(`Comments can be up to ${BULK_MAX_CHARS.comment.toLocaleString()} characters.`)
    const target = patch.targetUrl === undefined ? row.target_url : this.target(patch.targetUrl)
    this.db.run('UPDATE comment_drafts SET body = :body, target_url = :target, updated_at = :at WHERE id = :id', { id, body, target, at: new Date().toISOString() })
    return toComment(this.db.get<Row>('SELECT * FROM comment_drafts WHERE id = :id', { id })!)
  }

  remove(id: Id): void {
    this.db.run('DELETE FROM comment_drafts WHERE id = :id', { id })
  }

  /** Called by a campaign when it plans these comments. */
  markUsed(ids: Id[], at: string): void {
    if (ids.length) this.db.run('UPDATE comment_drafts SET used_at = :at WHERE id IN (SELECT value FROM json_each(:ids))', { ids: JSON.stringify(ids), at })
  }

  /** A target must be a link to a post on X (stored as https://x.com/<handle>/status/<id>). */
  private target(url: string | null): string | null {
    if (url === null || !url.trim()) return null
    const parsed = parsePostUrl(url)
    if (!parsed) throw new ValidationError('The target must be a link to a post on X (https://x.com/<name>/status/<number>).')
    return parsed.url
  }
}
