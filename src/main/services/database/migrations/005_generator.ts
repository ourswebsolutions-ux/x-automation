import type { Migration } from './index'

/**
 * Phase 6: tweet generator and editor.
 *
 * - generations: every generator / editing-tool request — settings, results,
 *   provider and model, status, provider-reported usage. No secrets: provider
 *   keys never leave the vault, and error text is the sanitised user message.
 * - drafts.hashtags: hashtags kept apart from the body so they can be edited
 *   and suggested separately (JSON array, without "#").
 * - drafts.source_generation_id: which generation a draft came from.
 *
 * The Phase 2 generated_content table is left untouched (it was never used).
 */
export const m005Generator: Migration = {
  version: 5,
  name: 'generator',
  sql: /* sql */ `
CREATE TABLE generations (
  id               TEXT PRIMARY KEY,
  operation        TEXT NOT NULL CHECK (operation IN ('generate', 'rewrite', 'improve', 'shorten', 'expand', 'tone',
                     'translate', 'alternatives', 'hashtags', 'opening', 'cta')),
  status           TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'cancelled')),
  provider_id      TEXT REFERENCES provider_configs(id) ON DELETE SET NULL,
  provider_name    TEXT NOT NULL,
  model            TEXT,
  settings         TEXT NOT NULL DEFAULT '{}',
  source_text      TEXT,
  results          TEXT NOT NULL DEFAULT '[]',
  draft_id         TEXT REFERENCES drafts(id) ON DELETE SET NULL,
  finish_reason    TEXT,
  error_kind       TEXT,
  error_message    TEXT,
  error_hint       TEXT,
  usage_record_id  TEXT REFERENCES ai_usage(id) ON DELETE SET NULL,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  total_tokens     INTEGER,
  usage_reported   INTEGER NOT NULL DEFAULT 0 CHECK (usage_reported IN (0, 1)),
  duration_ms      INTEGER,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_generations_created ON generations(created_at DESC);
CREATE INDEX idx_generations_draft ON generations(draft_id);

ALTER TABLE drafts ADD COLUMN hashtags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE drafts ADD COLUMN source_generation_id TEXT REFERENCES generations(id) ON DELETE SET NULL;
CREATE INDEX idx_drafts_created_at ON drafts(created_at DESC);
`
}
