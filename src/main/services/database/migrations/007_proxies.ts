import type { Migration } from './index'

/**
 * Pre-Phase 8: proxy manager.
 *
 * - proxies: connection details only. Passwords are never stored here — they
 *   live in the OS-encrypted credential vault (key "proxy:<id>"); has_password
 *   records that one exists.
 * - proxy_assignments: one proxy per IX Browser profile, with whether IX
 *   Browser accepted it (status/error). Deleting a proxy that is assigned is
 *   refused (RESTRICT); deleting a profile removes its assignment.
 * - The default proxy id lives in app_settings ("proxy.defaultId").
 */
export const m007Proxies: Migration = {
  version: 7,
  name: 'proxies',
  sql: /* sql */ `
CREATE TABLE proxies (
  id                TEXT PRIMARY KEY,
  label             TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  scheme            TEXT NOT NULL CHECK (scheme IN ('http', 'https', 'socks5')),
  host              TEXT NOT NULL CHECK (length(host) BETWEEN 1 AND 253),
  port              INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  username          TEXT CHECK (username IS NULL OR length(username) <= 255),
  has_password      INTEGER NOT NULL DEFAULT 0 CHECK (has_password IN (0, 1)),
  enabled           INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  notes             TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 1000),
  last_test_at      TEXT,
  last_test_ok      INTEGER CHECK (last_test_ok IS NULL OR last_test_ok IN (0, 1)),
  last_latency_ms   INTEGER,
  last_error        TEXT,
  last_verified     TEXT CHECK (last_verified IS NULL OR last_verified IN ('tunnel', 'tls')),
  last_target       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_proxies_identity ON proxies(scheme, lower(host), port, COALESCE(username, ''));

CREATE TABLE proxy_assignments (
  profile_id  TEXT PRIMARY KEY REFERENCES browser_profiles(id) ON DELETE CASCADE,
  proxy_id    TEXT NOT NULL REFERENCES proxies(id) ON DELETE RESTRICT,
  status      TEXT NOT NULL CHECK (status IN ('applied', 'failed')),
  applied_at  TEXT,
  error       TEXT,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_proxy_assignments_proxy ON proxy_assignments(proxy_id);
`
}
