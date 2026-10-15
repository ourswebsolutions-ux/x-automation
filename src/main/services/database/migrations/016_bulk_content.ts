import type { Migration } from './index'

/**
 * Bulk posts and comments (pasted from ChatGPT or any list). Additive only: no existing table changes.
 *
 * - comment_drafts: saved comments for campaigns. target_url is the post it is meant for
 *   (https://x.com/<handle>/status/<id>) or NULL until a campaign pairs it with a selected post;
 *   used_at is set when a campaign plans it. position keeps the pasted order within a save.
 * - bulk_saves: one row per bulk save (its request id), with the result. A repeated request (a double
 *   click, a retry after a lost reply) returns that result instead of saving the items again.
 */
export const m016BulkContent: Migration = {
  version: 16,
  name: 'bulk_content',
  sql: /* sql */ `
CREATE TABLE comment_drafts (
  id          TEXT PRIMARY KEY,
  body        TEXT NOT NULL,
  target_url  TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  used_at     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_comment_drafts_created ON comment_drafts(created_at DESC, position);

CREATE TABLE bulk_saves (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('posts', 'comments')),
  result      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
`
}
