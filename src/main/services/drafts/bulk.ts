import { BULK_MAX_ITEMS, bulkItemProblems, duplicateKey, type BulkKind } from '@shared/lib/bulkParse'
import type { BulkSaveInput, BulkSaveResult } from '@shared/types/domain'
import type { SqliteDatabase } from '../database/driver'
import { ValidationError } from '../errors'

/**
 * One bulk save, the same for posts and comments:
 *  - checked again here (the renderer's preview is not trusted): empty and too-long items, repeats
 *    within the request and texts that are already saved are skipped, each with its reason;
 *  - every remaining item is written in one transaction, together with the request's record, so a
 *    failure saves nothing (and the renderer keeps the pasted text) and success saves every item;
 *  - a request id that was already saved returns the first result (a double click or a retry never
 *    saves the items twice). Everything here is synchronous, so two calls can't interleave.
 */
export function bulkSave(
  db: SqliteDatabase,
  kind: BulkKind,
  input: BulkSaveInput,
  existingTexts: string[],
  insert: (text: string, index: number) => string
): BulkSaveResult {
  if (input.items.length === 0) throw new ValidationError(`Nothing to save — paste your ${kind === 'post' ? 'posts' : 'comments'} first.`)
  if (input.items.length > BULK_MAX_ITEMS) throw new ValidationError(`Up to ${BULK_MAX_ITEMS} ${kind === 'post' ? 'posts' : 'comments'} can be saved at once (${input.items.length} were sent). Save the rest in a second batch.`)
  const earlier = repeatedResult(db, input.requestId)
  if (earlier) return earlier

  const existing = new Set(existingTexts.map(duplicateKey))
  const firstIndex = new Map<string, number>()
  const toSave: { index: number; text: string }[] = []
  const skipped: BulkSaveResult['skipped'] = []
  input.items.forEach((item, index) => {
    const text = item.text.trim()
    const blocking = bulkItemProblems(text, kind, input.lengthProfile).find((p) => p.blocking)
    if (blocking) return skipped.push({ index, reason: blocking.message })
    const key = duplicateKey(text)
    const first = firstIndex.get(key)
    if (first !== undefined) return skipped.push({ index, reason: `Same text as item ${first + 1} — saved once.` })
    firstIndex.set(key, index)
    if (existing.has(key)) return skipped.push({ index, reason: `Already saved as ${kind === 'post' ? 'a draft' : 'a comment'}.` })
    toSave.push({ index, text })
  })

  return db.transaction(() => {
    // Checked again inside the transaction: the same request can't be saved twice.
    const again = repeatedResult(db, input.requestId)
    if (again) return again
    const saved = toSave.map(({ index, text }) => ({ index, id: insert(text, index) }))
    const result: BulkSaveResult = { requestId: input.requestId, repeated: false, saved, skipped }
    db.run('INSERT INTO bulk_saves (id, kind, result, created_at) VALUES (:id, :kind, :result, :at)', {
      id: input.requestId,
      kind: kind === 'post' ? 'posts' : 'comments',
      result: JSON.stringify({ saved, skipped }),
      at: new Date().toISOString()
    })
    return result
  })
}

function repeatedResult(db: SqliteDatabase, requestId: string): BulkSaveResult | null {
  const row = db.get<{ result: string }>('SELECT result FROM bulk_saves WHERE id = :id', { id: requestId })
  if (!row) return null
  const stored = JSON.parse(row.result) as Pick<BulkSaveResult, 'saved' | 'skipped'>
  return { requestId, repeated: true, saved: stored.saved, skipped: stored.skipped }
}
