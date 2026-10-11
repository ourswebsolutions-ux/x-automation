import type { ImageGenerationRecord } from '@shared/types/images'
import type { SqliteDatabase } from '../driver'
import { str, strOrNull, type Row } from './tableRepository'

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))

export type StoredImageGeneration = Omit<ImageGenerationRecord, 'assets'>

const fromRow = (r: Row, assetIds: string[]): StoredImageGeneration => ({
  id: str(r.id),
  status: r.status as ImageGenerationRecord['status'],
  providerId: strOrNull(r.provider_id),
  providerName: str(r.provider_name),
  model: strOrNull(r.model),
  prompt: str(r.prompt),
  size: str(r.size),
  quality: strOrNull(r.quality),
  format: strOrNull(r.format),
  assetIds,
  revisedPrompt: strOrNull(r.revised_prompt),
  usage: Number(r.usage_reported) === 1 ? { inputTokens: num(r.input_tokens), outputTokens: num(r.output_tokens), totalTokens: num(r.total_tokens) } : null,
  error: r.error_kind ? { kind: r.error_kind as never, message: str(r.error_message ?? ''), hint: str(r.error_hint ?? '') } : null,
  durationMs: num(r.duration_ms),
  draftId: strOrNull(r.draft_id),
  createdAt: str(r.created_at)
})

/** Image generation history (image_generations). Result images are image_assets rows pointing back here. */
export class ImageGenerationRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(record: StoredImageGeneration, usageRecordId: string | null): void {
    this.db.run(
      `INSERT INTO image_generations (id, status, provider_id, provider_name, model, prompt, size, quality, format, revised_prompt, draft_id,
         error_kind, error_message, error_hint, usage_record_id, input_tokens, output_tokens, total_tokens, usage_reported, duration_ms, created_at)
       VALUES (:id, :status, :providerId, :providerName, :model, :prompt, :size, :quality, :format, :revisedPrompt, :draftId,
         :errorKind, :errorMessage, :errorHint, :usageRecordId, :inputTokens, :outputTokens, :totalTokens, :usageReported, :durationMs, :createdAt)`,
      {
        id: record.id,
        status: record.status,
        providerId: record.providerId,
        providerName: record.providerName,
        model: record.model,
        prompt: record.prompt,
        size: record.size,
        quality: record.quality,
        format: record.format,
        revisedPrompt: record.revisedPrompt,
        draftId: record.draftId,
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

  markFailed(id: string, error: { kind: string; message: string; hint: string }): void {
    this.db.run("UPDATE image_generations SET status = 'failed', error_kind = :kind, error_message = :message, error_hint = :hint WHERE id = :id", { id, ...error })
  }

  list(limit: number): StoredImageGeneration[] {
    return this.db.all<Row>('SELECT * FROM image_generations ORDER BY created_at DESC, rowid DESC LIMIT :limit', { limit }).map((r) => fromRow(r, this.assetIds(str(r.id))))
  }

  get(id: string): StoredImageGeneration | null {
    const row = this.db.get<Row>('SELECT * FROM image_generations WHERE id = :id', { id })
    return row ? fromRow(row, this.assetIds(id)) : null
  }

  draftExists(id: string): boolean {
    return Boolean(this.db.get('SELECT 1 AS x FROM drafts WHERE id = :id', { id }))
  }

  private assetIds(generationId: string): string[] {
    return this.db.all<{ id: string }>('SELECT id FROM image_assets WHERE image_generation_id = :generationId ORDER BY created_at', { generationId }).map((r) => r.id)
  }
}
