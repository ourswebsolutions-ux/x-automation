import type { Migration } from './index'

/**
 * Initial schema. Mirrors src/shared/types. Timestamps are ISO-8601 UTC.
 * No table ever stores a secret: credential_refs holds only a vault key name
 * and a four-character hint.
 */
export const m001Initial: Migration = {
  version: 1,
  name: 'initial',
  sql: /* sql */ `
CREATE TABLE app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE notification_preferences (
  event       TEXT PRIMARY KEY,
  in_app      INTEGER NOT NULL CHECK (in_app IN (0, 1)),
  desktop     INTEGER NOT NULL CHECK (desktop IN (0, 1)),
  updated_at  TEXT NOT NULL
);

CREATE TABLE provider_configs (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('ixbrowser', 'openai-compatible', 'image')),
  name        TEXT NOT NULL,
  endpoint    TEXT NOT NULL,
  model       TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  settings    TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_provider_configs_name ON provider_configs(kind, name COLLATE NOCASE);

CREATE TABLE credential_refs (
  id           TEXT PRIMARY KEY,
  provider_id  TEXT NOT NULL UNIQUE REFERENCES provider_configs(id) ON DELETE CASCADE,
  vault_key    TEXT NOT NULL UNIQUE,
  hint         TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE browser_profiles (
  id              TEXT PRIMARY KEY,
  external_id     TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  group_name      TEXT,
  proxy_label     TEXT,
  last_opened_at  TEXT,
  synced_at       TEXT NOT NULL
);

CREATE TABLE accounts (
  id                  TEXT PRIMARY KEY,
  handle              TEXT NOT NULL UNIQUE,
  display_name        TEXT NOT NULL,
  browser_profile_id  TEXT REFERENCES browser_profiles(id) ON DELETE SET NULL,
  group_name          TEXT NOT NULL DEFAULT 'Default',
  status              TEXT NOT NULL CHECK (status IN ('active', 'paused', 'attention', 'unlinked')),
  last_active_at      TEXT,
  tags                TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE drafts (
  id          TEXT PRIMARY KEY,
  body        TEXT NOT NULL,
  account_id  TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  status      TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'scheduled', 'published', 'failed')),
  origin      TEXT NOT NULL CHECK (origin IN ('manual', 'ai')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_drafts_updated_at ON drafts(updated_at DESC);

CREATE TABLE generated_content (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('text', 'image')),
  provider_id  TEXT REFERENCES provider_configs(id) ON DELETE SET NULL,
  model        TEXT,
  prompt       TEXT NOT NULL,
  output       TEXT,
  draft_id     TEXT REFERENCES drafts(id) ON DELETE SET NULL,
  usage        TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE image_assets (
  id                    TEXT PRIMARY KEY,
  draft_id              TEXT REFERENCES drafts(id) ON DELETE SET NULL,
  generated_content_id  TEXT REFERENCES generated_content(id) ON DELETE SET NULL,
  file_path             TEXT NOT NULL,
  mime_type             TEXT NOT NULL,
  width                 INTEGER,
  height                INTEGER,
  alt_text              TEXT NOT NULL DEFAULT '',
  origin                TEXT NOT NULL CHECK (origin IN ('upload', 'generated')),
  created_at            TEXT NOT NULL
);
CREATE INDEX idx_image_assets_draft ON image_assets(draft_id);

CREATE TABLE scheduled_posts (
  id          TEXT PRIMARY KEY,
  draft_id    TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  run_at      TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending', 'queued', 'completed', 'cancelled'))
);
CREATE INDEX idx_scheduled_posts_run_at ON scheduled_posts(run_at);

CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('publish', 'reply', 'generate-text', 'generate-image', 'sync-profiles')),
  status       TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  account_id   TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  label        TEXT NOT NULL,
  payload      TEXT NOT NULL DEFAULT '{}',
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  finished_at  TEXT,
  error        TEXT
);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_created_at ON tasks(created_at DESC);

CREATE TABLE task_runs (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt      INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  error        TEXT
);
CREATE INDEX idx_task_runs_task ON task_runs(task_id);

CREATE TABLE post_links (
  id            TEXT PRIMARY KEY,
  url           TEXT NOT NULL UNIQUE,
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  draft_id      TEXT REFERENCES drafts(id) ON DELETE SET NULL,
  published_at  TEXT NOT NULL
);

CREATE TABLE activity (
  id       TEXT PRIMARY KEY,
  level    TEXT NOT NULL CHECK (level IN ('info', 'success', 'warning', 'error')),
  message  TEXT NOT NULL,
  subject  TEXT,
  at       TEXT NOT NULL
);
CREATE INDEX idx_activity_at ON activity(at DESC);

CREATE TABLE logs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL,
  level    TEXT NOT NULL CHECK (level IN ('debug', 'info', 'success', 'warning', 'error')),
  scope    TEXT NOT NULL,
  message  TEXT NOT NULL,
  meta     TEXT
);
CREATE INDEX idx_logs_at ON logs(at DESC);
CREATE INDEX idx_logs_level ON logs(level);
`
}
