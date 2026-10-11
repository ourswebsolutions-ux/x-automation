import type { FinishReason } from '@shared/types/ai'
import type { GenerationHistoryQuery, GenerationRecord } from '@shared/types/generator'
import type { Params, SqliteDatabase } from '../driver'
import { parseJson, str, strOrNull, type Row } from './tableRepository'

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))

const fromRow = (r: Row): GenerationRecord => ({
  id: str(r.id),
  operation: r.operation as GenerationRecord['operation'],
  status: r.status as GenerationRecord['status'],
  providerId: strOrNull(r.provider_id),
  providerName: str(r.provider_name),
  model: strOrNull(r.model),
  settings: parseJson(r.settings, {}) as GenerationRecord['settings'],
  sourceText: strOrNull(r.source_text),
  results: parseJson<unknown[]>(r.results, []).filter((x): x is string => typeof x === 'string'),
  draftId: strOrNull(r.draft_id),
  finishReason: (strOrNull(r.finish_reason) as FinishReason | null) ?? null,
  error: r.error_kind ? { kind: r.error_kind as never, message: str(r.error_message ?? ''), hint: str(r.error_hint ?? '') } : null,
  usage: Number(r.usage_reported) === 1 ? { inputTokens: num(r.input_tokens), outputTokens: num(r.output_tokens), totalTokens: num(r.total_tokens) } : null,
  durationMs: num(r.duration_ms),
  createdAt: str(r.created_at)
})

/** Generation history (generations). Settings and results are JSON; no secrets are ever stored. */
export class GenerationRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(record: GenerationRecord, usageRecordId: string | null): void {
    this.db.run(
      `INSERT INTO generations (id, operation, status, provider_id, provider_name, model, settings, source_text, results, draft_id,
         finish_reason, error_kind, error_message, error_hint, usage_record_id, input_tokens, output_tokens, total_tokens, usage_reported,
         duration_ms, created_at)
       VALUES (:id, :operation, :status, :providerId, :providerName, :model, :settings, :sourceText, :results, :draftId,
         :finishReason, :errorKind, :errorMessage, :errorHint, :usageRecordId, :inputTokens, :outputTokens, :totalTokens, :usageReported,
         :durationMs, :createdAt)`,
      {
        id: record.id,
        operation: record.operation,
        status: record.status,
        providerId: record.providerId,
        providerName: record.providerName,
        model: record.model,
        settings: JSON.stringify(record.settings),
        sourceText: record.sourceText,
        results: JSON.stringify(record.results),
        draftId: record.draftId,
        finishReason: record.finishReason,
        errorKind: record.error?.kind ?? null,
        errorMessage: record.error?.message ?? null,
        errorHint: record.error?.hint ?? null,
        usageRecordId,
        inputTokens: record.usage?.inputTokens ?? null,
        outputTokens: record.usage?.outputTokens ?? null,
        totalTokens: record.usage?.totalTokens ?? null,
        usageReported: record.usage !== null,
        durationMs: record.durationMs,
        createdAt: record.createdAt
      }
    )
  }

  draftExists(id: string): boolean {
    return Boolean(this.db.get('SELECT 1 AS x FROM drafts WHERE id = :id', { id }))
  }

  get(id: string): GenerationRecord | null {
    const row = this.db.get<Row>('SELECT * FROM generations WHERE id = :id', { id })
    return row ? fromRow(row) : null
  }

  list(query: GenerationHistoryQuery): GenerationRecord[] {
    const clauses: string[] = []
    const params: Params = { limit: query.limit ?? 50 }
    if (query.draftId) (clauses.push('draft_id = :draftId'), (params.draftId = query.draftId))
    if (query.operation === 'generate') clauses.push("operation = 'generate'")
    if (query.operation === 'assist') clauses.push("operation <> 'generate'")
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return this.db.all<Row>(`SELECT * FROM generations ${where} ORDER BY created_at DESC, rowid DESC LIMIT :limit`, params).map(fromRow)
  }
}
