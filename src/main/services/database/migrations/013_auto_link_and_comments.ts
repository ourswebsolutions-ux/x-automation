import type { Migration } from './index'

/**
 * Automatic profile linking and comments on posts.
 *
 * - drafts.comment_text / comment_enabled: a comment saved with the post. After X confirms the
 *   post, the same account posts it as a reply to that post (a 'reply' task in the queue).
 * - browser_profiles.link_excluded_at / disconnected_account_id: the user disconnected this
 *   profile's account, so syncs don't link it again; connecting it again re-links that same
 *   account (its username and history are kept).
 * - profile_sync_runs.linked / link_failed / link_errors: what automatic linking did after a sync
 *   (link_errors: JSON [{ profileId, name, reason }]).
 */
export const m013AutoLinkAndComments: Migration = {
  version: 13,
  name: 'auto_link_and_comments',
  sql: /* sql */ `
ALTER TABLE drafts ADD COLUMN comment_text TEXT NOT NULL DEFAULT '';
ALTER TABLE drafts ADD COLUMN comment_enabled INTEGER NOT NULL DEFAULT 0 CHECK (comment_enabled IN (0, 1));

ALTER TABLE browser_profiles ADD COLUMN link_excluded_at TEXT;
ALTER TABLE browser_profiles ADD COLUMN disconnected_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL;

ALTER TABLE profile_sync_runs ADD COLUMN linked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profile_sync_runs ADD COLUMN link_failed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profile_sync_runs ADD COLUMN link_errors TEXT NOT NULL DEFAULT '[]';

CREATE INDEX idx_tasks_kind_draft ON tasks(kind, draft_id);
`
}
