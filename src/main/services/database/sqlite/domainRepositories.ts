import type { ActivityEvent, Draft, MediaAttachment } from '@shared/types/domain'
import type { SqliteDatabase } from '../driver'
import type { ActivityRepository } from '../repositories'
import { parseJson, str, strOrNull, TableRepository, type Row } from './tableRepository'

/** Drafts with their image attachments (draft_attachments → image_assets), in order. */
class DraftRepository extends TableRepository<Draft> {
  constructor(
    db: SqliteDatabase,
    table: string,
    columns: readonly string[],
    mapper: ConstructorParameters<typeof TableRepository<Draft>>[3],
    orderBy: string,
    private readonly assetExists: (relativePath: string) => boolean
  ) {
    super(db, table, columns, mapper, orderBy)
  }

  private media(draftId: string): MediaAttachment[] {
    return this.db
      .all<Row>(
        `SELECT a.id, a.file_path, a.mime_type, a.width, a.height, a.size_bytes, a.animated, d.alt_text
         FROM draft_attachments d JOIN image_assets a ON a.id = d.asset_id
         WHERE d.draft_id = :draftId ORDER BY d.position`,
        { draftId }
      )
      .map((r) => ({
        id: str(r.id),
        kind: 'image',
        url: `relay-asset://asset/${str(r.id)}`,
        altText: str(r.alt_text),
        mimeType: str(r.mime_type),
        width: Number(r.width ?? 0),
        height: Number(r.height ?? 0),
        sizeBytes: Number(r.size_bytes ?? 0),
        animated: Number(r.animated) === 1,
        available: this.assetExists(str(r.file_path))
      }))
  }

  override async list(): Promise<Draft[]> {
    return (await super.list()).map((draft) => ({ ...draft, media: this.media(draft.id) }))
  }

  override async get(id: string): Promise<Draft | null> {
    const draft = await super.get(id)
    return draft ? { ...draft, media: this.media(id) } : null
  }
}

export function draftsRepository(db: SqliteDatabase, assetExists: (relativePath: string) => boolean = () => true) {
  return new DraftRepository(
    db,
    'drafts',
    ['id', 'body', 'hashtags', 'account_id', 'status', 'origin', 'source_generation_id', 'comment_text', 'comment_enabled', 'created_at', 'updated_at'],
    {
      toRow: (d) => ({
        id: d.id,
        body: d.body,
        hashtags: JSON.stringify(d.hashtags),
        source_generation_id: d.sourceGenerationId,
        account_id: d.accountId,
        status: d.status,
        origin: d.origin,
        // Drafts written before comments existed have none.
        comment_text: d.comment?.text ?? '',
        comment_enabled: d.comment?.enabled ? 1 : 0,
        created_at: d.createdAt,
        updated_at: d.updatedAt
      }),
      fromRow: (r) => ({
        id: str(r.id),
        body: str(r.body),
        hashtags: parseJson<unknown[]>(r.hashtags, []).filter((t): t is string => typeof t === 'string'),
        sourceGenerationId: strOrNull(r.source_generation_id),
        accountId: strOrNull(r.account_id),
        status: r.status as Draft['status'],
        origin: r.origin as Draft['origin'],
        media: [],
        comment: { enabled: Number(r.comment_enabled ?? 0) === 1, text: str(r.comment_text ?? '') },
        createdAt: str(r.created_at),
        updatedAt: str(r.updated_at)
      })
    },
    'updated_at DESC',
    assetExists
  )
}

export function activityRepository(db: SqliteDatabase): ActivityRepository {
  return {
    async append(event: ActivityEvent) {
      db.run('INSERT INTO activity (id, level, message, subject, at) VALUES (:id, :level, :message, :subject, :at)', { ...event })
    },
    async recent(limit: number) {
      return db.all<Row>('SELECT * FROM activity ORDER BY at DESC LIMIT :limit', { limit }).map((r) => ({
        id: str(r.id),
        level: r.level as ActivityEvent['level'],
        message: str(r.message),
        subject: strOrNull(r.subject),
        at: str(r.at)
      }))
    },
    pruneBefore(iso: string) {
      return db.run('DELETE FROM activity WHERE at < :iso', { iso }).changes
    }
  }
}
