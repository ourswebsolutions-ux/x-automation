import { randomUUID } from 'node:crypto'
import type { BulkResult } from '@shared/types/accounts'
import type { Id } from '@shared/types/domain'
import type { LinkAddInput, LinkAddResult, LinkUpdate, PostLinkView } from '@shared/types/links'
import type { AccountRepository } from '../database/sqlite/accountRepository'
import type { PostLinkRepository } from '../database/sqlite/postLinkRepository'
import { NotFoundError, ValidationError } from '../errors'
import type { ScopedLogger } from '../logging/logger'
import { parseCsv } from '../proxies/proxyFormat'
import { parsePostUrl } from '../publishing/postUrl'

interface Deps {
  repo: PostLinkRepository
  accounts: AccountRepository
  log: ScopedLogger
  onChange: () => void
  now?: () => Date
}

export const MAX_LINKS_PER_BATCH = 5000
const MAX_TAGS = 10
const MAX_TAG_CHARS = 30
const MAX_NOTES = 2000

interface Candidate {
  line: number
  text: string
  accountRef?: string
  tags?: string[]
  notes?: string
  publishedAt?: string | null
}

/** Trims, de-duplicates (case-insensitively) and limits tags. */
export function cleanTags(tags: string[]): string[] {
  const out: string[] = []
  for (const raw of tags) {
    const tag = raw.replace(/[,;|\n\r\t]/g, ' ').trim().replace(/\s+/g, ' ')
    if (!tag) continue
    if (tag.length > MAX_TAG_CHARS) throw new ValidationError(`Tags can be up to ${MAX_TAG_CHARS} characters (“${tag.slice(0, 20)}…”).`)
    if (out.some((t) => t.toLowerCase() === tag.toLowerCase())) continue
    out.push(tag)
  }
  if (out.length > MAX_TAGS) throw new ValidationError(`Use at most ${MAX_TAGS} tags per link.`)
  return out
}

const csvCell = (value: string | number | null) => {
  const text = value === null ? '' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * Post links: the ones publishing recorded plus any the user adds or imports.
 * These are local records — removing one never touches the post on X, and
 * nothing here reads from X (no metrics, no fetching).
 */
export class LinkService {
  constructor(private readonly deps: Deps) {}

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString()
  }

  list(): PostLinkView[] {
    return this.deps.repo.list()
  }

  get(id: Id): PostLinkView {
    const link = this.deps.repo.view(id)
    if (!link) throw new NotFoundError('That link no longer exists.')
    return link
  }

  /** Adds links pasted by the user (one per line, or separated by spaces/commas). */
  add(input: LinkAddInput): LinkAddResult {
    const tags = cleanTags(input.tags)
    const notes = this.cleanNotes(input.notes)
    if (input.accountId && !this.deps.accounts.get(input.accountId)) throw new ValidationError('That account no longer exists.')
    const candidates: Candidate[] = []
    input.text.split(/\r?\n/).forEach((line, index) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) return
      const tokens = trimmed.split(/[\s,]+/).filter(Boolean)
      // A line with no link at all (e.g. a sentence) is reported once, as a whole.
      if (!tokens.some((t) => parsePostUrl(t))) candidates.push({ line: index + 1, text: trimmed })
      else for (const token of tokens) candidates.push({ line: index + 1, text: token })
    })
    const result = this.insertAll(candidates, { accountId: input.accountId, tags, notes, source: 'manual' })
    this.deps.log.info(`Added ${result.added.length} post link(s)`, { duplicates: result.duplicates.length, rejected: result.rejected.length })
    return result
  }

  /**
   * Imports a TXT (one link per line) or CSV file. CSV columns (header row,
   * any order): url (required), account (label or @username), tags
   * (separated by ; or |), notes, published_at.
   */
  importText(text: string): LinkAddResult {
    const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
    const isCsv = /(^|,)\s*"?url"?\s*(,|$)/i.test(firstLine)
    let candidates: Candidate[] = []
    if (isCsv) {
      const rows = parseCsv(text)
      const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'))
      const col = (name: string) => header.indexOf(name)
      const [url, account, tags, notes, published] = [col('url'), col('account'), col('tags'), col('notes'), col('published_at')]
      rows.slice(1).forEach((row, index) => {
        const cell = (i: number) => (i >= 0 ? (row[i] ?? '').trim() : '')
        if (row.every((c) => !c.trim())) return
        const publishedText = cell(published)
        const publishedAt = publishedText && !Number.isNaN(Date.parse(publishedText)) ? new Date(publishedText).toISOString() : null
        candidates.push({
          line: index + 2,
          text: cell(url),
          accountRef: cell(account) || undefined,
          tags: cell(tags) ? cell(tags).split(/[;|]/) : undefined,
          notes: cell(notes) || undefined,
          publishedAt
        })
      })
    } else {
      candidates = text
        .split(/\r?\n/)
        .map((line, index) => ({ line: index + 1, text: line.trim() }))
        .filter((c) => c.text && !c.text.startsWith('#'))
    }
    const result = this.insertAll(candidates, { accountId: null, tags: [], notes: '', source: 'imported' })
    this.deps.log.info(`Imported ${result.added.length} post link(s)`, { format: isCsv ? 'csv' : 'txt', duplicates: result.duplicates.length, rejected: result.rejected.length })
    return result
  }

  update(id: Id, update: LinkUpdate): PostLinkView {
    if (!this.deps.repo.get(id)) throw new NotFoundError('That link no longer exists.')
    if (update.accountId && !this.deps.accounts.get(update.accountId)) throw new ValidationError('That account no longer exists.')
    this.deps.repo.update(id, { accountId: update.accountId, tags: cleanTags(update.tags), notes: this.cleanNotes(update.notes) }, this.now())
    this.deps.onChange()
    return this.get(id)
  }

  /** Adds tags to several links at once (keeps their existing tags). */
  addTags(ids: Id[], tags: string[]): BulkResult {
    const extra = cleanTags(tags)
    const result: BulkResult = { changed: 0, skipped: [] }
    this.deps.repo.transaction(() => {
      for (const id of new Set(ids)) {
        const link = this.deps.repo.view(id)
        if (!link) {
          result.skipped.push({ id, reason: 'Not found' })
          continue
        }
        try {
          this.deps.repo.update(id, { accountId: link.accountId, tags: cleanTags([...link.tags, ...extra]), notes: link.notes }, this.now())
          result.changed++
        } catch (error) {
          result.skipped.push({ id, reason: error instanceof Error ? error.message : 'Not updated' })
        }
      }
    })
    if (result.changed) this.deps.onChange()
    return result
  }

  /** Removes local link records (and their engagement tasks). Posts on X are not affected. */
  remove(ids: Id[]): BulkResult {
    const result: BulkResult = { changed: 0, skipped: [] }
    this.deps.repo.transaction(() => {
      for (const id of new Set(ids)) {
        if (this.deps.repo.remove(id)) result.changed++
        else result.skipped.push({ id, reason: 'Not found' })
      }
    })
    if (result.changed) {
      this.deps.log.info(`Removed ${result.changed} post link record(s)`)
      this.deps.onChange()
    }
    return result
  }

  /** CSV of the given links (all when omitted). Contains no secrets. */
  exportCsv(ids?: Id[]): { csv: string; count: number } {
    const wanted = ids ? new Set(ids) : null
    const links = this.list().filter((l) => !wanted || wanted.has(l.id))
    const header = ['url', 'post_id', 'username', 'account', 'source', 'published_at', 'tags', 'notes', 'open_tasks', 'done_tasks']
    const lines = links.map((l) =>
      [l.url, l.postId, l.handle, l.accountLabel, l.source, l.publishedAt, l.tags.join('; '), l.notes, l.openTasks, l.doneTasks].map(csvCell).join(',')
    )
    return { csv: `${[header.join(','), ...lines].join('\r\n')}\r\n`, count: links.length }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private cleanNotes(notes: string): string {
    const trimmed = notes.trim()
    if (trimmed.length > MAX_NOTES) throw new ValidationError(`Notes can be up to ${MAX_NOTES} characters.`)
    return trimmed
  }

  private resolveAccount(ref: string): Id | null | undefined {
    const name = ref.trim().replace(/^@/, '')
    const byHandle = /^[A-Za-z0-9_]{1,15}$/.test(name) ? this.deps.accounts.byHandle(name) : null
    if (byHandle) return byHandle.id
    const byLabel = this.deps.accounts.list().find((a) => a.label.toLowerCase() === ref.trim().toLowerCase())
    return byLabel ? byLabel.id : undefined
  }

  private insertAll(candidates: Candidate[], defaults: { accountId: Id | null; tags: string[]; notes: string; source: 'manual' | 'imported' }): LinkAddResult {
    if (candidates.length > MAX_LINKS_PER_BATCH) throw new ValidationError(`Add at most ${MAX_LINKS_PER_BATCH.toLocaleString()} links at a time.`)
    const result: LinkAddResult = { added: [], duplicates: [], rejected: [] }
    const seen = new Map<string, Id>()
    const now = this.now()
    this.deps.repo.transaction(() => {
      for (const c of candidates) {
        const parsed = parsePostUrl(c.text)
        if (!parsed) {
          result.rejected.push({ line: c.line, text: c.text.slice(0, 120), reason: c.text ? 'Not a link to a post on X' : 'Missing link' })
          continue
        }
        const existing = seen.get(parsed.postId) ?? this.deps.repo.byUrlOrPostId(parsed.url, parsed.postId)?.id
        if (existing) {
          result.duplicates.push({ url: parsed.url, existingId: existing })
          continue
        }
        let accountId: Id | null = defaults.accountId
        if (c.accountRef) {
          const resolved = this.resolveAccount(c.accountRef)
          if (resolved === undefined) {
            result.rejected.push({ line: c.line, text: c.text.slice(0, 120), reason: `Unknown account “${c.accountRef.slice(0, 40)}”` })
            continue
          }
          accountId = resolved
        } else if (!accountId && parsed.handle) {
          accountId = this.deps.accounts.byHandle(parsed.handle)?.id ?? null
        }
        let tags: string[]
        let notes: string
        try {
          tags = cleanTags([...defaults.tags, ...(c.tags ?? [])])
          notes = this.cleanNotes(c.notes ?? defaults.notes)
        } catch (error) {
          result.rejected.push({ line: c.line, text: c.text.slice(0, 120), reason: error instanceof Error ? error.message : 'Invalid tags or notes' })
          continue
        }
        const id = randomUUID()
        this.deps.repo.insert({
          id,
          url: parsed.url,
          postId: parsed.postId,
          handle: parsed.handle,
          accountId,
          draftId: null,
          taskId: null,
          source: defaults.source,
          preview: '',
          publishedAt: c.publishedAt ?? null,
          createdAt: now,
          notes,
          tags
        })
        seen.set(parsed.postId, id)
        result.added.push(this.deps.repo.view(id)!)
      }
    })
    if (result.added.length) this.deps.onChange()
    return result
  }
}
