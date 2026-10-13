import type { Migration } from './index'

/**
 * Campaigns publish every selected post from every eligible account. A selected post appears at most
 * once per account in a campaign: a database guarantee, so a retry, a resumed run or a double start
 * can never plan the same post twice for one account.
 */
export const m014CampaignPostPerAccount: Migration = {
  version: 14,
  name: 'campaign_post_per_account',
  sql: /* sql */ `
CREATE UNIQUE INDEX idx_run_items_post_account ON run_items(run_id, source_draft_id, account_id)
  WHERE kind = 'post' AND source_draft_id IS NOT NULL AND account_id IS NOT NULL;
`
}
