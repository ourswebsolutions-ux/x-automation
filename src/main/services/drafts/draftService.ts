import { randomUUID } from 'node:crypto'
import { attachmentProblem, attachmentSetProblem, X_MEDIA_LIMITS } from '@shared/config/mediaLimits'
import { MAX_HASHTAGS, normalizeHashtag } from '@shared/config/postLimits'
import { commentProblems, NO_COMMENT } from '@shared/lib/postComment'
import type { AttachmentInput, Draft, DraftInput, Id, PostComment } from '@shared/types/domain'
import type { AssetRepository } from '../database/sqlite/assetRepository'
import type { SqliteDatabase } from '../database/driver'
import type { WorkspaceRepositories } from '../database/repositories'
import { NotFoundError, ValidationError } from '../errors'
import type { ScopedLogger } from '../logging/logger'

export const MAX_DRAFT_CHARS = 25_000

/** Local drafts. Nothing here publishes anything. */
export class DraftService {
  constructor(
    private readonly repositories: WorkspaceRepositories,
    private readonly db: SqliteDatabase,
    private readonly assets: AssetRepository,
    private readonly log: ScopedLogger,
    private readonly fileExists: (relativePath: string) => boolean = () => true
  ) {}

  async list(): Promise<Draft[]> {
    const drafts = await this.repositories.drafts.list()
    return drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async get(id: Id): Promise<Draft> {
    const draft = await this.repositories.drafts.get(id)
    if (!draft) throw new NotFoundError('That draft no longer exists.')
    return draft
  }

  async save(input: DraftInput): Promise<Draft> {
    const now = new Date().toISOString()
    const existing = input.id ? await this.repositories.drafts.get(input.id) : null
    if (input.id && !existing) throw new NotFoundError('That draft no longer exists — it may have been deleted.')
    const body = input.body
    const attachments = input.attachments === undefined ? null : this.checkAttachments(input.attachments)
    const hasMedia = attachments ? attachments.length > 0 : (existing?.media.length ?? 0) > 0
    if (!body.trim() && !(input.hashtags ?? existing?.hashtags ?? []).length && !hasMedia) throw new ValidationError('A draft needs some text or an image.')
    if (body.length > MAX_DRAFT_CHARS) throw new ValidationError(`Drafts can be up to ${MAX_DRAFT_CHARS.toLocaleString()} characters.`)
    const hashtags = this.cleanHashtags(input.hashtags ?? existing?.hashtags ?? [])
    const comment = input.comment === undefined ? (existing?.comment ?? NO_COMMENT) : this.checkComment(input.comment)
    if (input.accountId && !this.exists('accounts', input.accountId)) throw new ValidationError('That account no longer exists.')
    const sourceGenerationId = input.sourceGenerationId === undefined ? (existing?.sourceGenerationId ?? null) : input.sourceGenerationId
    if (sourceGenerationId && !this.exists('generations', sourceGenerationId)) throw new ValidationError('That generation no longer exists.')
    if (existing && existing.status !== 'draft' && existing.status !== 'ready') {
      throw new ValidationError('This post is scheduled or published and can no longer be edited here.')
    }

    const draft: Draft = existing
      ? {
          ...existing,
          body,
          hashtags,
          accountId: input.accountId,
          status: input.status ?? existing.status,
          origin: existing.origin === 'ai' || input.aiAssisted ? 'ai' : 'manual',
          sourceGenerationId,
          comment,
          updatedAt: now
        }
      : {
          id: randomUUID(),
          body,
          hashtags,
          accountId: input.accountId,
          status: input.status ?? 'draft',
          origin: input.aiAssisted || sourceGenerationId ? 'ai' : 'manual',
          sourceGenerationId,
          media: [],
          comment,
          createdAt: now,
          updatedAt: now
        }

    this.db.transaction(() => {
      void this.repositories.drafts.upsert(draft)
      if (attachments) {
        this.assets.replaceAttachments(draft.id, attachments)
        for (const a of attachments) this.assets.setKept(a.assetId, true)
      }
    })
    await this.recordActivity(existing ? 'Draft updated' : 'Draft created', draft)
    this.log.info(`${existing ? 'Updated' : 'Created'} draft ${draft.id.slice(0, 8)}`, { chars: draft.body.length, origin: draft.origin })
    return (await this.repositories.drafts.get(draft.id)) ?? draft
  }

  /** A new, independent copy (status reset to draft). Attachments are not copied. */
  async duplicate(id: Id): Promise<Draft> {
    const source = await this.get(id)
    const now = new Date().toISOString()
    const copy: Draft = {
      ...source,
      id: randomUUID(),
      status: 'draft',
      media: [],
      createdAt: now,
      updatedAt: now
    }
    this.db.transaction(() => {
      void this.repositories.drafts.upsert(copy)
      // Attachments reference library images, so the copy can share them.
      this.assets.replaceAttachments(copy.id, this.assets.attachments(id))
    })
    await this.recordActivity('Draft duplicated', copy)
    this.log.info(`Duplicated draft ${id.slice(0, 8)} → ${copy.id.slice(0, 8)}`)
    return (await this.repositories.drafts.get(copy.id)) ?? copy
  }

  async remove(id: Id): Promise<void> {
    const draft = await this.repositories.drafts.get(id)
    if (!draft) return
    const busy = this.db.get(
      `SELECT 1 AS x FROM scheduled_posts WHERE draft_id = :id AND status IN ('pending', 'queued', 'missed', 'needs-review')
       UNION SELECT 1 FROM tasks WHERE draft_id = :id AND status IN ('queued', 'running', 'needs-review')`,
      { id }
    )
    if (busy) throw new ValidationError('This draft is scheduled or being published. Cancel the schedule first.')
    await this.repositories.drafts.remove(id)
    await this.recordActivity('Draft deleted', draft)
    this.log.info(`Deleted draft ${id.slice(0, 8)}`)
  }

  /** The comment saved with the post: a turned-off comment keeps its text; a turned-on one must be postable. */
  private checkComment(comment: PostComment): PostComment {
    const text = comment.text.trim()
    if (text.length > MAX_DRAFT_CHARS) throw new ValidationError(`Comments can be up to ${MAX_DRAFT_CHARS.toLocaleString()} characters.`)
    const blocking = commentProblems({ enabled: comment.enabled, text }).find((p) => p.blocking)
    if (blocking) throw new ValidationError(blocking.message)
    return { enabled: comment.enabled && Boolean(text), text }
  }

  /** Applies X's verified attachment rules (see shared/config/mediaLimits.ts). */
  private checkAttachments(items: AttachmentInput[]): AttachmentInput[] {
    const seen = new Set<string>()
    const unique = items.filter((item) => !seen.has(item.assetId) && seen.add(item.assetId))
    const rows = unique.map((item) => {
      const row = this.assets.get(item.assetId)
      if (!row) throw new ValidationError('An attached image is no longer in the library.')
      if (!this.fileExists(row.filePath)) throw new ValidationError(`“${row.originalName}” is missing from the image folder — remove it or attach another image.`)
      const problem = attachmentProblem(row)
      if (problem) throw new ValidationError(`“${row.originalName}”: ${problem}`)
      if (item.altText.length > X_MEDIA_LIMITS.maxAltTextChars) throw new ValidationError(`Image descriptions can be up to ${X_MEDIA_LIMITS.maxAltTextChars} characters.`)
      return row
    })
    const setProblem = attachmentSetProblem(rows)
    if (setProblem) throw new ValidationError(setProblem)
    return unique.map((item) => ({ assetId: item.assetId, altText: item.altText.trim() }))
  }

  private cleanHashtags(tags: string[]): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    for (const raw of tags) {
      const tag = normalizeHashtag(raw)
      if (!tag) throw new ValidationError(`“${raw.slice(0, 40)}” is not a valid hashtag — use letters, numbers and underscores.`)
      if (seen.has(tag.toLowerCase())) continue
      seen.add(tag.toLowerCase())
      out.push(tag)
    }
    if (out.length > MAX_HASHTAGS) throw new ValidationError(`Use at most ${MAX_HASHTAGS} hashtags.`)
    return out
  }

  private exists(table: 'accounts' | 'generations', id: string): boolean {
    return Boolean(this.db.get(`SELECT 1 AS x FROM ${table} WHERE id = :id`, { id }))
  }

  private recordActivity(message: string, draft: Draft): Promise<void> {
    const preview = draft.body.trim().replace(/\s+/g, ' ')
    return this.repositories.activity.append({
      id: randomUUID(),
      level: message === 'Draft deleted' ? 'warning' : 'info',
      message,
      subject: preview.length > 48 ? `${preview.slice(0, 48)}…` : preview,
      at: new Date().toISOString()
    })
  }
}
