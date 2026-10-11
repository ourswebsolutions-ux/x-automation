import type { Migration } from './index'

/**
 * Phase 8: tweet queue, scheduling and publishing.
 *
 * Rebuilds the Phase 2 placeholder tables (which nothing wrote to) with what a
 * persistent, crash-safe queue needs, copying any existing rows:
 *
 * - scheduled_posts: one row per planned post. A draft can have at most one
 *   active schedule (partial unique index). 'missed' = the slot passed while
 *   the app was closed and is waiting for the user; 'needs-review' = the
 *   publish attempt's outcome could not be confirmed.
 * - tasks: the queue. idempotency_key makes "one schedule → one publish task"
 *   a database guarantee; run_after drives backoff and spacing. A task is
 *   claimed with a conditional UPDATE, so two workers can never run it.
 *   'needs-review' = it may already have taken effect (e.g. the post button
 *   was clicked but success was not confirmed) — it is never retried
 *   automatically.
 * - task_runs: one row per attempt, with the last stage reached and a
 *   plain-language outcome.
 * - post_links: links to posts, with the X post id and the handle seen in the
 *   link; task_id ties a link to the publish task that produced it.
 *
 * Runs with foreign keys off for the rebuild (see Migration.disableForeignKeys).
 */
export const m008Publishing: Migration = {
  version: 8,
  name: 'publishing',
  disableForeignKeys: true,
  sql: /* sql */ `
CREATE TABLE scheduled_posts_new (
  id           TEXT PRIMARY KEY,
  draft_id     TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  run_at       TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'queued', 'completed', 'cancelled', 'failed', 'missed', 'needs-review')),
  reminded_at  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
INSERT INTO scheduled_posts_new (id, draft_id, account_id, run_at, status, created_at, updated_at)
  SELECT id, draft_id, account_id, run_at, status, run_at, run_at FROM scheduled_posts;
DROP TABLE scheduled_posts;
ALTER TABLE scheduled_posts_new RENAME TO scheduled_posts;
CREATE INDEX idx_scheduled_posts_due ON scheduled_posts(status, run_at);
CREATE INDEX idx_scheduled_posts_account ON scheduled_posts(account_id, run_at);
CREATE UNIQUE INDEX idx_scheduled_posts_active_draft ON scheduled_posts(draft_id)
  WHERE status IN ('pending', 'queued', 'missed', 'needs-review');

CREATE TABLE tasks_new (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('publish', 'reply', 'generate-text', 'generate-image', 'sync-profiles')),
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
  updated_at       TEXT NOT NULL
);
INSERT INTO tasks_new (id, kind, status, account_id, label, payload, attempts, run_after, finished_at, error, created_at, updated_at)
  SELECT id, kind, status, account_id, label, payload, attempts, created_at, finished_at, error, created_at, COALESCE(finished_at, created_at) FROM tasks;

CREATE TABLE task_runs_new (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks_new(id) ON DELETE CASCADE,
  attempt      INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled', 'uncertain')),
  stage        TEXT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  error_code   TEXT,
  error        TEXT
);
INSERT INTO task_runs_new (id, task_id, attempt, status, started_at, finished_at, error)
  SELECT id, task_id, attempt, status, started_at, finished_at, error FROM task_runs;
DROP TABLE task_runs;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
ALTER TABLE task_runs_new RENAME TO task_runs;
CREATE INDEX idx_tasks_runnable ON tasks(status, run_after);
CREATE INDEX idx_tasks_created_at ON tasks(created_at DESC);
CREATE INDEX idx_tasks_account ON tasks(account_id);
CREATE INDEX idx_tasks_draft ON tasks(draft_id);
CREATE INDEX idx_task_runs_task ON task_runs(task_id, attempt);

CREATE TABLE post_links_new (
  id            TEXT PRIMARY KEY,
  url           TEXT NOT NULL UNIQUE,
  post_id       TEXT,
  handle        TEXT,
  account_id    TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  draft_id      TEXT REFERENCES drafts(id) ON DELETE SET NULL,
  task_id       TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  source        TEXT NOT NULL CHECK (source IN ('published', 'manual', 'imported')),
  preview       TEXT NOT NULL DEFAULT '',
  published_at  TEXT,
  created_at    TEXT NOT NULL
);
INSERT INTO post_links_new (id, url, account_id, draft_id, source, published_at, created_at)
  SELECT id, url, account_id, draft_id, 'manual', published_at, published_at FROM post_links;
DROP TABLE post_links;
ALTER TABLE post_links_new RENAME TO post_links;
CREATE UNIQUE INDEX idx_post_links_post_id ON post_links(post_id) WHERE post_id IS NOT NULL;
CREATE INDEX idx_post_links_account ON post_links(account_id, published_at DESC);
CREATE INDEX idx_post_links_created ON post_links(created_at DESC);
`
}
