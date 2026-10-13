import type { Migration } from './index'

/**
 * Reposts and comments from campaigns run in the task queue (they used to be to-do items only).
 *
 * The tasks table's kind CHECK gains 'repost' (comments use the existing 'reply' kind). SQLite can't
 * change a CHECK in place, so the table is rebuilt with SQLite's documented procedure, copying every
 * row and column and recreating every index. Foreign keys pointing at tasks (task_runs, post_links)
 * keep pointing at the rebuilt table.
 */
export const m015RepostTasks: Migration = {
  version: 15,
  name: 'repost_tasks',
  disableForeignKeys: true,
  sql: /* sql */ `
CREATE TABLE tasks_new (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('publish', 'reply', 'repost', 'generate-text', 'generate-image', 'sync-profiles')),
  status           TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'needs-review')),
  account_id       TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  draft_id         TEXT REFERENCES drafts(id) ON DELETE SET NULL,
  schedule_id      TEXT REFERENCES scheduled_posts(id) ON DELETE SET NULL,
  label            TEXT NOT NULL,
  payload          TEXT NOT NULL DEFAULT '{}',
  idempotency_key  TEXT UNIQUE,
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts     INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  run_after        TEXT NOT NULL,
  started_at       TEXT,
  finished_at      TEXT,
  error_code       TEXT,
  error            TEXT,
  result           TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  held             INTEGER NOT NULL DEFAULT 0 CHECK (held IN (0, 1))
);
INSERT INTO tasks_new (id, kind, status, account_id, draft_id, schedule_id, label, payload, idempotency_key, attempts, max_attempts, run_after, started_at, finished_at, error_code, error, result, created_at, updated_at, held)
  SELECT id, kind, status, account_id, draft_id, schedule_id, label, payload, idempotency_key, attempts, max_attempts, run_after, started_at, finished_at, error_code, error, result, created_at, updated_at, held FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
CREATE INDEX idx_tasks_created_at ON tasks(created_at DESC);
CREATE INDEX idx_tasks_account ON tasks(account_id);
CREATE INDEX idx_tasks_draft ON tasks(draft_id);
CREATE INDEX idx_tasks_runnable ON tasks(status, held, run_after);
CREATE INDEX idx_tasks_kind_draft ON tasks(kind, draft_id);
`
}
