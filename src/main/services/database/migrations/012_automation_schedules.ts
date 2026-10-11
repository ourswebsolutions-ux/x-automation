import type { Migration } from './index'

/**
 * Phase 12 (review): recurring automation schedules and drafts as a content source.
 *
 * - automation_schedules: an automation that runs on chosen days inside a daily
 *   window between a start and an optional end date — independent of the
 *   schedules of individual posts. The config is a snapshot (taken when the
 *   schedule is saved); each day it runs it starts one automation run.
 * - automation_runs.schedule_id: which schedule started a run (null = started by hand).
 * - run_items.source_draft_id: the user's own draft a post comes from (null = generated).
 */
export const m012AutomationSchedules: Migration = {
  version: 12,
  name: 'automation_schedules',
  sql: /* sql */ `
CREATE TABLE automation_schedules (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  status         TEXT NOT NULL CHECK (status IN ('active', 'paused', 'ended')),
  config         TEXT NOT NULL,
  preset_id      TEXT REFERENCES prompt_presets(id) ON DELETE SET NULL,
  start_date     TEXT NOT NULL CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  end_date       TEXT CHECK (end_date IS NULL OR end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  days           INTEGER NOT NULL CHECK (days BETWEEN 1 AND 127),
  window_start   TEXT NOT NULL,
  window_end     TEXT NOT NULL,
  last_run_date  TEXT,
  last_run_id    TEXT REFERENCES automation_runs(id) ON DELETE SET NULL,
  last_message   TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_automation_schedules_name ON automation_schedules(lower(name));

ALTER TABLE automation_runs ADD COLUMN schedule_id TEXT REFERENCES automation_schedules(id) ON DELETE SET NULL;
CREATE INDEX idx_automation_runs_schedule ON automation_runs(schedule_id, created_at DESC);

ALTER TABLE run_items ADD COLUMN source_draft_id TEXT REFERENCES drafts(id) ON DELETE SET NULL;
`
}
