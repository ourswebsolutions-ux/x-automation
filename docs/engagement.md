# Post links and engagement tasks (Phase 9)

## Post links

- Every post X Auto publishes (and X confirms) is saved with its post id and handle.
- Links can also be **pasted** (one per line, or separated by spaces/commas) or **imported**
  from TXT (one link per line) or CSV (`url`, `account`, `tags`, `notes`, `published_at` —
  header row, any order). x.com and twitter.com links are accepted (with or without
  `www`/`mobile`, query strings or `/photo/1`), and stored as `https://x.com/<handle>/status/<id>`.
- Duplicates are found by post id; lines that are not post links are reported with their line
  number and skipped.
- A link is matched to one of your accounts by the username in it (or by an `account` column /
  your choice). Tags (up to 10) and notes are local.
- **Export** writes a CSV. Removing a link removes only the local record and its tasks — the post
  on X is never touched. Nothing is read from X: no metrics, no fetching.

## Engagement tasks

**Reposts and comments planned by a campaign** are done by X Auto as soon as the campaign runs
(see [automation.md](automation.md)):

- They are queue tasks (`repost`, `reply`), one per engagement task (idempotency key `engage:<id>`).
  They run right away and survive restarts. A task an earlier version scheduled for later still
  waits for its time. A time missed while X Auto was closed is not done late, and you can retry the
  task to do it now.
- A repost counts only when the post shows *Undo repost* on X; a comment only with X's confirmation
  (or once found among the account's replies).
- A repost that was clicked but not confirmed waits for your review, like posts. Marking it done
  needs the post's link.
- Tasks you create in Post Links, and likes, are still done by you, as described below.

An engagement task is a reminder of something **you** will do with a post from one of your
accounts: reply, like, repost, quote, bookmark, follow up, or anything else. X Auto never
likes, reposts, quotes, replies or follows on its own.

- **Open in profile** opens the post in a new tab of the account's own IX Browser profile (its
  signed-in session; the profile is opened through the Local API if needed). Nothing on the page is
  clicked or typed (`x.openPost` engine command; only `https://x.com/<handle>/status/<id>` links).
- Reply/quote text can be prepared and copied; you paste and post it yourself.
- Tasks have an optional due time, a note, and are marked done, skipped or reopened.

### Guardrails (checked when planning and when editing)

| Rule | Why |
| --- | --- |
| A post from one of your accounts can't be liked, reposted or quoted from your **other** accounts | Artificial amplification under X's platform manipulation rules |
| Only one of your accounts may like, repost or quote a given post (open or done tasks count; skipped ones don't) | Coordinated engagement across accounts |
| One open task per post, account and kind | No duplicates |
| A daily guideline per account (default 25 tasks, Settings → Automation; 0 = off) | Keeps activity paced like a person's |
| Replies, bookmarks and follow-ups are not limited by the amplification rules | They don't inflate a post's reach |

Ownership is taken from the link's account, or from its username when it matches one of your
accounts.

## Verification

- 46 unit checks (parsing, import/export, matching, every guardrail, opening in a profile).
- 30 end-to-end checks in the real app; **Open in profile** verified against a real Chrome (as the
  profile's browser, via CDP) and the local X stand-in — the tab stays open for the user and
  nothing is posted. Not verified against x.com or a real IX Browser profile (not available here).
