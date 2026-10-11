import type { Id, PostLink, PostLinkSource } from '@shared/types/domain'
import type { LinkUpdate, PostLinkView } from '@shared/types/links'
import type { SqliteDatabase } from '../driver'
import { str, strOrNull, type Row } from './tableRepository'

const tagsOf = (value: unknown): string[] => {
  try {
    const parsed = JSON.parse(typeof value === 'string' ? value : '[]') as unknown
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

const fromRow = (r: Row): PostLink => ({
  id: str(r.id),
  url: str(r.url),
  postId: strOrNull(r.post_id),
  handle: strOrNull(r.handle),
  accountId: strOrNull(r.account_id),
  draftId: strOrNull(r.draft_id),
  taskId: strOrNull(r.task_id),
  source: r.source as PostLinkSource,
  preview: str(r.preview ?? ''),
  publishedAt: strOrNull(r.published_at),
  createdAt: str(r.created_at)
})

const toView = (r: Row): PostLinkView => ({
  ...fromRow(r),
  notes: str(r.notes ?? ''),
  tags: tagsOf(r.tags),
  updatedAt: str(r.updated_at ?? r.created_at),
  accountLabel: strOrNull(r.account_label),
  openTasks: Number(r.open_tasks ?? 0),
  doneTasks: Number(r.done_tasks ?? 0)
})

const VIEW_SELECT = `SELECT l.*, a.label AS account_label,
    (SELECT COUNT(*) FROM engagement_tasks e WHERE e.link_id = l.id AND e.status = 'open') AS open_tasks,
    (SELECT COUNT(*) FROM engagement_tasks e WHERE e.link_id = l.id AND e.status = 'done') AS done_tasks
  FROM post_links l LEFT JOIN accounts a ON a.id = l.account_id`

/** Links to posts on X (local records only). */
export class PostLinkRepository {
  constructor(private readonly db: SqliteDatabase) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)
  }

  insert(link: PostLink & { notes?: string; tags?: string[] }): void {
    this.db.run(
      `INSERT INTO post_links (id, url, post_id, handle, account_id, draft_id, task_id, source, preview, published_at, created_at, updated_at, notes, tags)
       VALUES (:id, :url, :postId, :handle, :accountId, :draftId, :taskId, :source, :preview, :publishedAt, :createdAt, :createdAt, :notes, :tags)`,
      {
        id: link.id,
        url: link.url,
        postId: link.postId,
        handle: link.handle,
        accountId: link.accountId,
        draftId: link.draftId,
        taskId: link.taskId,
        source: link.source,
        preview: link.preview,
        publishedAt: link.publishedAt,
        createdAt: link.createdAt,
        notes: link.notes ?? '',
        tags: JSON.stringify(link.tags ?? [])
      }
    )
  }

  get(id: Id): PostLink | null {
    const row = this.db.get<Row>('SELECT * FROM post_links WHERE id = :id', { id })
    return row ? fromRow(row) : null
  }

  view(id: Id): PostLinkView | null {
    const row = this.db.get<Row>(`${VIEW_SELECT} WHERE l.id = :id`, { id })
    return row ? toView(row) : null
  }

  byUrlOrPostId(url: string, postId: string | null): PostLink | null {
    const row = this.db.get<Row>('SELECT * FROM post_links WHERE url = :url OR (post_id IS NOT NULL AND post_id = :postId)', { url, postId: postId ?? '' })
    return row ? fromRow(row) : null
  }

  byTask(taskId: Id): PostLink | null {
    const row = this.db.get<Row>('SELECT * FROM post_links WHERE task_id = :taskId', { taskId })
    return row ? fromRow(row) : null
  }

  list(limit = 5000): PostLinkView[] {
    return this.db.all<Row>(`${VIEW_SELECT} ORDER BY COALESCE(l.published_at, l.created_at) DESC LIMIT :limit`, { limit }).map(toView)
  }

  update(id: Id, update: LinkUpdate, now: string): boolean {
    return (
      this.db.run('UPDATE post_links SET account_id = :accountId, tags = :tags, notes = :notes, updated_at = :now WHERE id = :id', {
        id,
        accountId: update.accountId,
        tags: JSON.stringify(update.tags),
        notes: update.notes,
        now
      }).changes === 1
    )
  }

  remove(id: Id): boolean {
    return this.db.run('DELETE FROM post_links WHERE id = :id', { id }).changes === 1
  }

  count(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM post_links')?.n ?? 0
  }
}
