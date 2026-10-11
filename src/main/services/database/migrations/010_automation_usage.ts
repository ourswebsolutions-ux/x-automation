import type { Migration } from './index'

/**
 * Phases 10 + 11: automation controls and usage tracking.
 *
 * - tasks.held: a task the user put on hold. Held tasks stay queued but are
 *   never started until released (the whole queue can also be paused — that
 *   state lives in app_settings).
 * - usage_rates: prices the USER enters per provider/model. AI providers do not
 *   return a cost with their responses, so any cost shown is an estimate from
 *   these rates and is labelled as such.
 * - usage_limits: optional daily/monthly limits per provider (or all), on
 *   requests, tokens, images or estimated cost; 'warn' notifies, 'block' also
 *   stops new requests until the period ends or the limit changes.
 */
export const m010AutomationUsage: Migration = {
  version: 10,
  name: 'automation_usage',
  sql: /* sql */ `
ALTER TABLE tasks ADD COLUMN held INTEGER NOT NULL DEFAULT 0 CHECK (held IN (0, 1));
DROP INDEX IF EXISTS idx_tasks_runnable;
CREATE INDEX idx_tasks_runnable ON tasks(status, held, run_after);

CREATE TABLE usage_rates (
  id                   TEXT PRIMARY KEY,
  provider_id          TEXT NOT NULL REFERENCES provider_configs(id) ON DELETE CASCADE,
  model                TEXT CHECK (model IS NULL OR length(model) BETWEEN 1 AND 120),
  input_per_million    REAL CHECK (input_per_million IS NULL OR input_per_million >= 0),
  output_per_million   REAL CHECK (output_per_million IS NULL OR output_per_million >= 0),
  per_image            REAL CHECK (per_image IS NULL OR per_image >= 0),
  note                 TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  updated_at           TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_usage_rates_model ON usage_rates(provider_id, COALESCE(model, ''));

CREATE TABLE usage_limits (
  id                 TEXT PRIMARY KEY,
  provider_id        TEXT REFERENCES provider_configs(id) ON DELETE CASCADE,
  period             TEXT NOT NULL CHECK (period IN ('day', 'month')),
  metric             TEXT NOT NULL CHECK (metric IN ('requests', 'tokens', 'images', 'estimated-cost')),
  threshold          REAL NOT NULL CHECK (threshold > 0),
  action             TEXT NOT NULL CHECK (action IN ('warn', 'block')),
  warned_period      TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
`
}
