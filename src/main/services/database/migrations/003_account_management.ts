import type { Migration } from './index'

/**
 * Phase 4: X account management.
 *
 * The Phase 1 `accounts` table required a handle and mixed link state with
 * app state, so it is rebuilt (SQLite cannot alter constraints in place).
 * Existing rows are carried over; drafts, tasks, schedules and post links keep
 * pointing at the same account ids.
 *
 * - `label` is the user's own name for the record.
 * - `handle` is the X username, or NULL while unknown. It is never derived
 *   from a browser profile name. `identity` records how far it is trusted:
 *   'unverified' (entered) or 'confirmed' (explicitly confirmed by the user).
 * - `browser_profile_id` is UNIQUE: one profile belongs to at most one account.
 *   Removing an account never touches browser_profiles.
 * - `enabled` is a local preference for future task assignment only.
 *
 * Runs with foreign keys off (see Migration.disableForeignKeys); the migrator
 * runs PRAGMA foreign_key_check before committing.
 */
export const m003AccountManagement: Migration = {
  version: 3,
  name: 'account_management',
  disableForeignKeys: true,
  sql: /* sql */ `
CREATE TABLE accounts_new (
  id                     TEXT PRIMARY KEY,
  label                  TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  handle                 TEXT COLLATE NOCASE CHECK (handle IS NULL OR (length(handle) BETWEEN 1 AND 15 AND handle NOT GLOB '*[^A-Za-z0-9_]*')),
  identity               TEXT NOT NULL DEFAULT 'unknown' CHECK (identity IN ('unknown', 'unverified', 'confirmed')),
  identity_confirmed_at  TEXT,
  browser_profile_id     TEXT UNIQUE REFERENCES browser_profiles(id) ON DELETE SET NULL,
  linked_at              TEXT,
  enabled                INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  notes                  TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 4000),
  last_active_at         TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  CHECK ((handle IS NULL) = (identity = 'unknown')),
  CHECK (identity = 'confirmed' OR identity_confirmed_at IS NULL)
);

-- Carry Phase 1 rows over. They were never confirmed by the user, so any handle
-- becomes 'unverified'; handles that clash case-insensitively, are not valid X
-- usernames, or a second claim on the same profile are dropped rather than
-- guessed. Group and tags (no longer modelled) are kept in the notes.
INSERT INTO accounts_new (id, label, handle, identity, browser_profile_id, linked_at, enabled, notes, last_active_at, created_at, updated_at)
SELECT
  id,
  substr(COALESCE(NULLIF(trim(display_name), ''), handle), 1, 80),
  keep_handle,
  CASE WHEN keep_handle IS NULL THEN 'unknown' ELSE 'unverified' END,
  CASE WHEN profile_rank = 1 THEN browser_profile_id END,
  CASE WHEN profile_rank = 1 AND browser_profile_id IS NOT NULL THEN now END,
  CASE WHEN status = 'paused' THEN 0 ELSE 1 END,
  trim(
    CASE WHEN group_name NOT IN ('', 'Default') THEN 'Group: ' || group_name ELSE '' END ||
    CASE WHEN tags NOT IN ('', '[]') THEN char(10) || 'Tags: ' || tags ELSE '' END,
    char(10)
  ),
  last_active_at,
  now,
  now
FROM (
  SELECT a.*,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now,
    CASE
      WHEN length(a.handle) BETWEEN 1 AND 15 AND a.handle NOT GLOB '*[^A-Za-z0-9_]*'
       AND row_number() OVER (PARTITION BY lower(a.handle) ORDER BY a.rowid) = 1
      THEN a.handle
    END AS keep_handle,
    row_number() OVER (PARTITION BY COALESCE(a.browser_profile_id, a.id) ORDER BY a.rowid) AS profile_rank
  FROM accounts a
);

DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;

CREATE UNIQUE INDEX idx_accounts_handle ON accounts(handle) WHERE handle IS NOT NULL;
CREATE INDEX idx_accounts_label ON accounts(label COLLATE NOCASE);

-- Local history shown in the account details panel.
CREATE TABLE account_events (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN (
                'created', 'updated', 'identity', 'linked', 'unlinked', 'enabled', 'disabled',
                'profile-opened', 'profile-closed', 'profile-renamed', 'profile-unavailable',
                'profile-restored', 'operation-failed')),
  message     TEXT NOT NULL,
  at          TEXT NOT NULL
);
CREATE INDEX idx_account_events_account ON account_events(account_id, at DESC);
CREATE INDEX idx_account_events_at ON account_events(at);
`
}
