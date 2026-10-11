import type { Migration } from './index'

/**
 * Phase 5: AI provider integration.
 *
 * - provider_configs.adapter says how an AI text provider is called
 *   ('openai' = Responses API, 'openai-chat' = Chat Completions). Validated in
 *   code so new adapters don't need a table rebuild. Existing text
 *   configurations pointing at api.openai.com become 'openai'; the rest are
 *   treated as OpenAI-compatible.
 * - ai_usage records every AI request the app makes. Token columns hold only
 *   what the provider reported (NULL otherwise). Cost columns stay NULL until
 *   reliable pricing data exists — nothing is estimated from guesses.
 */
export const m004AiProviders: Migration = {
  version: 4,
  name: 'ai_providers',
  sql: /* sql */ `
ALTER TABLE provider_configs ADD COLUMN adapter TEXT;
UPDATE provider_configs
   SET adapter = CASE WHEN lower(endpoint) LIKE 'https://api.openai.com%' THEN 'openai' ELSE 'openai-chat' END
 WHERE kind = 'openai-compatible';

CREATE TABLE ai_usage (
  id                   TEXT PRIMARY KEY,
  provider_id          TEXT REFERENCES provider_configs(id) ON DELETE SET NULL,
  provider_name        TEXT NOT NULL,
  adapter              TEXT NOT NULL,
  model                TEXT,
  operation            TEXT NOT NULL CHECK (operation IN ('connection-test', 'list-models', 'generate-text', 'generate-image')),
  status               TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'cancelled')),
  error_kind           TEXT,
  started_at           TEXT NOT NULL,
  duration_ms          INTEGER,
  input_tokens         INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens        INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  total_tokens         INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
  usage_reported       INTEGER NOT NULL DEFAULT 0 CHECK (usage_reported IN (0, 1)),
  image_count          INTEGER,
  estimated_cost_usd   REAL,
  cost_source          TEXT,
  provider_request_id  TEXT
);
CREATE INDEX idx_ai_usage_started ON ai_usage(started_at DESC);
CREATE INDEX idx_ai_usage_provider ON ai_usage(provider_id, started_at DESC);
`
}
