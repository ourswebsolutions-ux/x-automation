import type { Migration } from './index'

/**
 * Phase 3: IX Browser profile synchronisation.
 * Extends browser_profiles in place (existing rows are preserved) and adds a
 * sync history table. No column may hold cookies, passwords or tokens.
 */
export const m002IxBrowserSync: Migration = {
  version: 2,
  name: 'ixbrowser_profile_sync',
  sql: /* sql */ `
ALTER TABLE browser_profiles ADD COLUMN provider_id TEXT REFERENCES provider_configs(id) ON DELETE SET NULL;
ALTER TABLE browser_profiles ADD COLUMN site_url TEXT;
ALTER TABLE browser_profiles ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
ALTER TABLE browser_profiles ADD COLUMN content_hash TEXT;
ALTER TABLE browser_profiles ADD COLUMN first_seen_at TEXT;
ALTER TABLE browser_profiles ADD COLUMN availability TEXT NOT NULL DEFAULT 'available'
  CHECK (availability IN ('available', 'unavailable'));
ALTER TABLE browser_profiles ADD COLUMN last_change TEXT NOT NULL DEFAULT 'new'
  CHECK (last_change IN ('new', 'updated', 'unchanged', 'unavailable'));
ALTER TABLE browser_profiles ADD COLUMN run_state TEXT NOT NULL DEFAULT 'unknown'
  CHECK (run_state IN ('running', 'closed', 'unknown'));
ALTER TABLE browser_profiles ADD COLUMN opened_by TEXT CHECK (opened_by IN ('api', 'client'));
ALTER TABLE browser_profiles ADD COLUMN status_checked_at TEXT;

UPDATE browser_profiles SET first_seen_at = synced_at WHERE first_seen_at IS NULL;
CREATE INDEX idx_browser_profiles_availability ON browser_profiles(availability);

CREATE TABLE profile_sync_runs (
  id           TEXT PRIMARY KEY,
  provider_id  TEXT REFERENCES provider_configs(id) ON DELETE SET NULL,
  status       TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  discovered   INTEGER NOT NULL DEFAULT 0,
  added        INTEGER NOT NULL DEFAULT 0,
  updated      INTEGER NOT NULL DEFAULT 0,
  unavailable  INTEGER NOT NULL DEFAULT 0,
  duplicates   INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);
CREATE INDEX idx_profile_sync_runs_started ON profile_sync_runs(started_at DESC);

-- A run left "running" by a crash is closed out on the next launch by the service.
`
}
