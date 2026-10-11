import type { Migration } from './index'

/**
 * Phase 7: image generation and attachments.
 *
 * - image_assets (Phase 1 table, never written to until now) gains the
 *   metadata the library needs. file_path is stored relative to the asset
 *   folder; the file itself never lives in SQLite.
 * - draft_attachments: ordered images per draft. One asset can be reused by
 *   several drafts; deleting an asset that a draft uses is refused
 *   (ON DELETE RESTRICT, and checked in the service first).
 * - image_generations: image requests, their settings, results and
 *   provider-reported usage. No secrets.
 * - ai_usage gains image size / format / quality columns.
 * - Image provider configurations get the 'openai-images' adapter.
 */
export const m006Images: Migration = {
  version: 6,
  name: 'images',
  sql: /* sql */ `
CREATE TABLE image_generations (
  id               TEXT PRIMARY KEY,
  status           TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'cancelled')),
  provider_id      TEXT REFERENCES provider_configs(id) ON DELETE SET NULL,
  provider_name    TEXT NOT NULL,
  model            TEXT,
  prompt           TEXT NOT NULL,
  size             TEXT NOT NULL,
  quality          TEXT,
  format           TEXT,
  revised_prompt   TEXT,
  draft_id         TEXT REFERENCES drafts(id) ON DELETE SET NULL,
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
CREATE INDEX idx_image_generations_created ON image_generations(created_at DESC);

ALTER TABLE image_assets ADD COLUMN original_name TEXT NOT NULL DEFAULT '';
ALTER TABLE image_assets ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE image_assets ADD COLUMN sha256 TEXT;
ALTER TABLE image_assets ADD COLUMN animated INTEGER NOT NULL DEFAULT 0 CHECK (animated IN (0, 1));
ALTER TABLE image_assets ADD COLUMN prompt TEXT;
ALTER TABLE image_assets ADD COLUMN image_generation_id TEXT REFERENCES image_generations(id) ON DELETE SET NULL;
ALTER TABLE image_assets ADD COLUMN kept INTEGER NOT NULL DEFAULT 1 CHECK (kept IN (0, 1));
CREATE UNIQUE INDEX idx_image_assets_sha256 ON image_assets(sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX idx_image_assets_created ON image_assets(created_at DESC);

CREATE TABLE draft_attachments (
  draft_id   TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  asset_id   TEXT NOT NULL REFERENCES image_assets(id) ON DELETE RESTRICT,
  position   INTEGER NOT NULL CHECK (position >= 0),
  alt_text   TEXT NOT NULL DEFAULT '' CHECK (length(alt_text) <= 1000),
  PRIMARY KEY (draft_id, asset_id)
);
CREATE INDEX idx_draft_attachments_asset ON draft_attachments(asset_id);

-- Any Phase 1-style links (image_assets.draft_id) become attachments.
INSERT INTO draft_attachments (draft_id, asset_id, position, alt_text)
SELECT draft_id, id, row_number() OVER (PARTITION BY draft_id ORDER BY created_at) - 1, substr(alt_text, 1, 1000)
FROM image_assets WHERE draft_id IS NOT NULL;

ALTER TABLE ai_usage ADD COLUMN image_size TEXT;
ALTER TABLE ai_usage ADD COLUMN image_format TEXT;
ALTER TABLE ai_usage ADD COLUMN image_quality TEXT;

UPDATE provider_configs SET adapter = 'openai-images' WHERE kind = 'image' AND adapter IS NULL;
`
}
