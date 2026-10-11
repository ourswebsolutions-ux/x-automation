import type { Migration } from './index'

/**
 * Phase 9: post link management and engagement tasks.
 *
 * - post_links gains notes, tags (JSON array) and updated_at. Links stay local
 *   records: deleting one never touches the post on X.
 * - engagement_tasks: a checklist of things a person intends to do with a post
 *   from one of their accounts (reply, like, repost, quote, bookmark, follow
 *   up). X Auto never performs these on X by itself. At most one open
 *   task per post, account and kind (partial unique index).
 */
export const m009Engagement: Migration = {
  version: 9,
  name: 'engagement',
  sql: /* sql */ `
ALTER TABLE post_links ADD COLUMN notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 2000);
ALTER TABLE post_links ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE post_links ADD COLUMN updated_at TEXT;
UPDATE post_links SET updated_at = created_at;

CREATE TABLE engagement_tasks (
  id            TEXT PRIMARY KEY,
  link_id       TEXT NOT NULL REFERENCES post_links(id) ON DELETE CASCADE,
  account_id    TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('reply', 'like', 'repost', 'quote', 'bookmark', 'follow-up', 'other')),
  status        TEXT NOT NULL CHECK (status IN ('open', 'done', 'skipped')),
  due_at        TEXT,
  note          TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  reply_text    TEXT NOT NULL DEFAULT '' CHECK (length(reply_text) <= 4000),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  completed_at  TEXT
);
CREATE INDEX idx_engagement_status_due ON engagement_tasks(status, due_at);
CREATE INDEX idx_engagement_link ON engagement_tasks(link_id);
CREATE INDEX idx_engagement_account ON engagement_tasks(account_id, due_at);
CREATE UNIQUE INDEX idx_engagement_open_unique ON engagement_tasks(link_id, COALESCE(account_id, ''), kind) WHERE status = 'open';
`
}
