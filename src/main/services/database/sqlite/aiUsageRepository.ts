import type { AiAdapterId, AiOperation } from '@shared/config/aiAdapters'
import type { AiErrorKind, AiRequestStatus, AiUsageQuery, AiUsageRecord, AiUsageSummary } from '@shared/types/ai'
import type { Params, SqliteDatabase } from '../driver'
import { str, strOrNull, type Row } from './tableRepository'

const num = (value: unknown) => (value === null || value === undefined ? null : Number(value))

const fromRow = (r: Row): AiUsageRecord => ({
  id: str(r.id),
  providerId: strOrNull(r.provider_id),
  providerName: str(r.provider_name),
  adapter: r.adapter as AiAdapterId,
  model: strOrNull(r.model),
  operation: r.operation as AiOperation,
  status: r.status as AiRequestStatus,
  errorKind: (strOrNull(r.error_kind) as AiErrorKind | null) ?? null,
  startedAt: str(r.started_at),
  durationMs: num(r.duration_ms),
  usage: Number(r.usage_reported) === 1 ? { inputTokens: num(r.input_tokens), outputTokens: num(r.output_tokens), totalTokens: num(r.total_tokens) } : null,
  imageCount: num(r.image_count),
  imageSize: strOrNull(r.image_size),
  imageFormat: strOrNull(r.image_format),
  imageQuality: strOrNull(r.image_quality),
  estimatedCostUsd: num(r.estimated_cost_usd),
  providerRequestId: strOrNull(r.provider_request_id)
})

/** Builds a WHERE clause from fixed column names; values are always bound. */
function where(query: AiUsageQuery): { sql: string; params: Params } {
  const clauses: string[] = []
  const params: Params = {}
  if (query.providerId) (clauses.push('provider_id = :providerId'), (params.providerId = query.providerId))
  if (query.operation) (clauses.push('operation = :operation'), (params.operation = query.operation))
  if (query.status) (clauses.push('status = :status'), (params.status = query.status))
  if (query.from) (clauses.push('started_at >= :from'), (params.from = query.from))
  if (query.to) (clauses.push('started_at <= :to'), (params.to = query.to))
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

/** AI request history (ai_usage). Token counts are stored exactly as reported. */
export class AiUsageRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(record: AiUsageRecord): void {
    this.db.run(
      `INSERT INTO ai_usage (id, provider_id, provider_name, adapter, model, operation, status, error_kind, started_at, duration_ms,
         input_tokens, output_tokens, total_tokens, usage_reported, image_count, image_size, image_format, image_quality, estimated_cost_usd, cost_source, provider_request_id)
       VALUES (:id, :providerId, :providerName, :adapter, :model, :operation, :status, :errorKind, :startedAt, :durationMs,
         :inputTokens, :outputTokens, :totalTokens, :usageReported, :imageCount, :imageSize, :imageFormat, :imageQuality, NULL, NULL, :providerRequestId)`,
      {
        id: record.id,
        providerId: record.providerId,
        providerName: record.providerName,
        adapter: record.adapter,
        model: record.model,
        operation: record.operation,
        status: record.status,
        errorKind: record.errorKind,
        startedAt: record.startedAt,
        durationMs: record.durationMs,
        inputTokens: record.usage?.inputTokens ?? null,
        outputTokens: record.usage?.outputTokens ?? null,
        totalTokens: record.usage?.totalTokens ?? null,
        usageReported: record.usage !== null,
        imageCount: record.imageCount,
        imageSize: record.imageSize,
        imageFormat: record.imageFormat,
        imageQuality: record.imageQuality,
        providerRequestId: record.providerRequestId
      }
    )
  }

  query(query: AiUsageQuery): AiUsageRecord[] {
    const { sql, params } = where(query)
    return this.db
      .all<Row>(`SELECT * FROM ai_usage ${sql} ORDER BY started_at DESC, rowid DESC LIMIT :limit`, { ...params, limit: query.limit ?? 200 })
      .map(fromRow)
  }

  summary(query: AiUsageQuery): AiUsageSummary {
    const { sql, params } = where(query)
    const row = this.db.get<Record<string, number | null>>(
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(status = 'succeeded'), 0) AS succeeded,
              COALESCE(SUM(status = 'failed'), 0) AS failed,
              COALESCE(SUM(status = 'cancelled'), 0) AS cancelled,
              COALESCE(SUM(usage_reported), 0) AS withUsage,
              COALESCE(SUM(input_tokens), 0) AS inputTokens,
              COALESCE(SUM(output_tokens), 0) AS outputTokens,
              COALESCE(SUM(total_tokens), 0) AS totalTokens
       FROM ai_usage ${sql}`,
      params
    )
    const n = (key: string) => Number(row?.[key] ?? 0)
    return {
      requests: n('requests'),
      succeeded: n('succeeded'),
      failed: n('failed'),
      cancelled: n('cancelled'),
      withUsage: n('withUsage'),
      inputTokens: n('inputTokens'),
      outputTokens: n('outputTokens'),
      totalTokens: n('totalTokens')
    }
  }
}
