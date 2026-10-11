import type { Migration } from './index'

/**
 * Phase 12: automation runs.
 *
 * - prompt_presets: reusable content + run settings (JSON, validated in the app).
 * - automation_runs: one "Start automation" press. The config is a snapshot
 *   taken at start, so later preset edits don't change a running workflow.
 * - run_items: one planned post (or engagement task) of a run, with the draft,
 *   target profile/account and schedule it produced. A post's publishing state
 *   comes from its schedule/task; run_items keep the generation side
 *   (pending → generating → ready / awaiting approval → scheduled) and why an
 *   item was skipped or failed.
 */
export const m011AutomationRuns: Migration = {
  version: 11,
  name: 'automation_runs',
  sql: /* sql */ `
CREATE TABLE prompt_presets (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  config      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_prompt_presets_name ON prompt_presets(lower(name));

CREATE TABLE automation_runs (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  mode         TEXT NOT NULL CHECK (mode IN ('full-auto', 'manual-approval')),
  status       TEXT NOT NULL CHECK (status IN ('generating', 'awaiting-approval', 'publishing', 'paused', 'completed', 'stopped', 'failed')),
  config       TEXT NOT NULL,
  preset_id    TEXT REFERENCES prompt_presets(id) ON DELETE SET NULL,
  message      TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  finished_at  TEXT
);
CREATE INDEX idx_automation_runs_created ON automation_runs(created_at DESC);

CREATE TABLE run_items (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('post', 'engagement')),
  status        TEXT NOT NULL CHECK (status IN ('pending', 'generating', 'awaiting-approval', 'scheduled', 'saved', 'skipped', 'failed', 'removed')),
  profile_id    TEXT REFERENCES browser_profiles(id) ON DELETE SET NULL,
  account_id    TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  draft_id      TEXT REFERENCES drafts(id) ON DELETE SET NULL,
  schedule_id   TEXT REFERENCES scheduled_posts(id) ON DELETE SET NULL,
  engagement_task_id TEXT REFERENCES engagement_tasks(id) ON DELETE SET NULL,
  run_at        TEXT,
  image         TEXT NOT NULL DEFAULT 'none' CHECK (image IN ('none', 'attached', 'failed', 'skipped')),
  error         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_run_items_run ON run_items(run_id, position);
CREATE INDEX idx_run_items_schedule ON run_items(schedule_id);
`
}
