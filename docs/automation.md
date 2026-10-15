# Creating posts and running campaigns

The sidebar's automation group has three pages:

- **Create Post** for writing posts (and their comments), then publishing or scheduling them.
- **Campaigns** for posting saved posts from every profile, now or at a date and time.
- **Synchronized Profiles** for syncing IX Browser profiles and seeing which ones can post.

Dashboard, Post Links and Settings are unchanged.

## Synchronized Profiles

**Sync profiles** fetches every profile from IX Browser's Local API and links each available profile
to an account automatically. There is no "select profiles → link accounts" step any more.

- **The first sync** creates one account record per profile, labelled with the profile name. The X
  username stays unknown: a profile name is not an X identity.
- **Later syncs** never create duplicates. A profile keeps its local id, and its link to its account
  (and the IX Browser profile id) as long as IX Browser reports it. Two syncs at once join into one.
- **A profile that can't be linked** is listed in the sync history with the reason. The next sync
  retries it. The other profiles are not affected.
- **A profile IX Browser stops reporting** becomes *Unavailable*. It keeps its account and comes
  back with the same account when it is reported again.

The **Posting** column shows each profile's status:

| Status | Meaning |
| --- | --- |
| Connected | Linked to an enabled account. Create Post and Campaigns use it. |
| Disabled | Its account is disabled for tasks (X accounts tab), so it is left out. |
| Disconnected | You disconnected it. Syncs leave it out until you press **Connect**, which links the same account again, keeping its username and history. |
| Link failed | The last sync couldn't link it; the reason is shown. Sync again to retry. |
| Unavailable | IX Browser no longer reports it. |

**Removing an account** (X accounts tab) also counts as disconnecting its profile.

**Confirming X usernames** (X accounts tab) is optional but recommended:

- For an account with a confirmed username, the engine checks which account is signed in to the
  profile before posting, and refuses to post from a different one.
- Without a confirmed username, the post goes out from whoever is signed in to that profile. The
  publish dialog and the campaign form show this as a warning.

## Create Post

Create Post is one page with an **AI Post / Manual Post / Bulk posts / Bulk comments** toggle. Saved
posts are listed on the left; together they are the content you can publish now or use in campaigns.

| | |
| --- | --- |
| **AI Post** | Describe the topic, main message, audience, tone and length, choose the AI provider and model, and generate variations. **Use this post** opens one in the editor (**Save for later** keeps it without opening). Facts in the brief are the only facts the AI may use. |
| **Manual Post** | Type the post yourself. No AI provider is needed. |

**The editor** is the same for both modes. There is no account to choose.

- **Post:** text, hashtags and the X length meter; images (**Upload**, **Library**, or **Generate**
  with the image provider); AI editing tools (optional).
- **Comment** (below the post, off by default): turn it on and write the comment. Once X confirms the
  post, each account that published it replies to its own post with this comment.
  - It is saved with the post and copied with it, including into the copy each profile gets.
  - A comment that is on must not be empty. Over 280 characters is a warning, because only X Premium
    accounts can post it.
  - The preview shows the comment as a reply under the post.
- **Save**. **Save** and **Publish…** turn into a single click while they run, so a post can't be
  submitted twice.

**Publish…** (on a saved post):

- **Publish now** or **Schedule** (date and time on this computer, with quick picks). The time is
  stored in UTC.
- **Who posts:** every synchronized profile that can post, meaning an enabled account on a profile
  IX Browser still reports. The dialog shows *N of M synchronized profiles will post*, names them, and
  lists any left out with the reason. With no usable profile it asks you to sync first, with a
  **Sync profiles** button.
- **Same text from several accounts:** allowed only with the explicit switch, because X can treat it
  as repeated or coordinated content. Each profile gets its own copy of the post and of its comment.
- **After sending**, the dialog follows each profile: waiting, publishing, published (with
  **View on X**), failed, or needs review. Below each post it shows the comment's progress (waiting,
  posting, posted, failed). A scheduled post shows *Scheduled* and goes out at its time while X Auto
  is running.

**Use in a campaign** opens Campaigns with the post already selected.

### Bulk posts and bulk comments (pasted lists)

For content written elsewhere, for example by asking ChatGPT in your browser for "300 different X
posts about …". X Auto never calls ChatGPT or any other AI service for this; there is no key or
setting for it. **Copy a prompt for ChatGPT** puts a suggested request on the clipboard.

1. Paste the whole answer into **Paste your posts** (or **Paste your comments**).
2. X Auto splits it into items and shows **N posts detected**, with the format it recognised:
   - **Numbered list:** `1.`, `2)`, `**3.**`, `Post 4:`, `Comment #5 -`. An item runs until the next
     number, so it can span several lines and paragraphs. Numbers must count up by one (from any
     start, such as 101 for a second batch). A `3.` inside a post that isn't the next number stays
     part of the post, as do times (`10:30`), decimals (`1.5x`) and years.
   - **Separated by blank lines:** each block is one item, with its line breaks.
   - **One per line:** every line is one item.
3. ChatGPT's introduction ("Sure! Here are 300 posts:") and closing note ("Let me know if …") are
   left out, as are headings and `---` lines. They are listed under *Left out*, so nothing disappears
   silently. A last item with an extra paragraph is kept and pointed out for you to check.
4. Only the list number (and `- ` bullets, when the whole list uses them) is removed. Hashtags,
   @mentions, links, emojis, punctuation and numbers in the text are kept as written.
5. **Review:** edit any item, or remove it (×). Each item shows its X length (emoji count 2, links
   count 23).
   - Empty items and items over the chosen limit (**Up to 280**, or **Longer posts** for X Premium) are
     marked and are not saved. Text is never cut.
   - Repeats (same words, ignoring spacing and case) are saved once.
   - More than **300** in one save is refused, and **Save** is disabled until you remove the extras.
6. **Save All as Drafts** / **Save All as Comment Drafts** saves every valid item in one click.
   - It runs as one database transaction. If the save fails, nothing is saved and your pasted text
     stays.
   - The click carries a request id for exactly this list. A double click, or a retry after a lost
     reply, returns the first result and never saves the items twice.
   - Texts that are already saved are skipped as *Already saved*.
   - The result says how many were saved, for example *300 drafts saved successfully*. Any item that
     wasn't saved is listed by number with its reason; the ones you can fix stay in the list.

**Saved posts** from a bulk save are ordinary drafts: they appear in the list on the left in the
pasted order, and in the Campaigns post picker (**Select all**).

**Saved comments** (Bulk comments) are listed next to the paste box. Each one can be edited, given a
**target post** (an x.com post link), or deleted, and there is a **Select all** for deleting.

- A target can be set for a whole paste, or later per comment. Without one, the comment waits until a
  campaign pairs it with a post you select.
- A target is never made up.
- A comment that a campaign has used is marked *Used*.

A post that is already scheduled, published or failed shows its status strip in the editor, with
actions such as **Change time**, **Publish now**, **Cancel schedule** or **Edit again**.

## Campaigns

The campaign form has four choices and one button: **Run campaign** (or **Schedule campaign** for a
date and time).

1. **Action:**
   - **Post** publishes your saved posts. A post that carries a comment is followed by that comment,
     as a reply from the same account.
   - **Repost**: X Auto reposts each chosen post (from Post Links) at the run time, in one randomly
     chosen account's profile (one account per post; accounts are drawn in the campaign's random
     order). It counts only once the post shows **Undo repost** on X (reloaded if
     needed). A post already reposted from that account counts as done without clicking again.
   - **Comment**: X Auto posts comments as replies at the run time, through the same composer and
     checks as posts, and counts each one only once X confirms it.
     - **Saved comments** (Create Post → Bulk comments): choose them, or **Select all** (the unused
       ones shown). A comment with its own target goes on that post. The others take the selected
       posts in order.
     - **One comment per post:** a comment with no post left, and a post with no comment left, are
       shown as skipped with the reason.
     - Without saved comments, you can still write one comment, which goes on one post.
   - **Rules for both** (X's automation rules): one of your accounts per post (never several of
     your accounts on one post), and never a post from one of your accounts amplified by your
     others. One post per comment, because the same comment on several posts is repetitive
     automated replying. The daily guideline per account (Settings → Automation) applies.
     Likes stay tasks you do yourself.
2. **Profiles:** *N of M synchronized profiles take part*, plus how many are unavailable or disabled,
   with **View profiles** and **Sync profiles**.
   - **All synchronized profiles** (the default), or **Choose profiles**, with a **Select all**.
   - Either way, only eligible profiles take part (an enabled account on a profile IX Browser
     reports), checked by the main process when the campaign starts.
   - With none synchronized, or none chosen, the form says so and the button is blocked.
3. **Posts:**
   - For Post, choose saved posts (AI or manual). **Each selected post goes out once, from one
     randomly chosen eligible profile**: 10 posts on 10 profiles = 10 posts, one per profile; 5 posts
     on 10 profiles = 5 posts on 5 random profiles. With more posts than profiles, a profile gets a
     second post only after every profile has one. Posts from one account are spaced out (Settings →
     Automation). Posts with a comment show a comment icon, and the form says how many comments will
     follow.
   - **Preview** (all actions): each post, its account and its time, before Start. Each new campaign
     gets its own random account order (a seed in its settings), so Start makes exactly the
     previewed assignment, and a retry or restart keeps it.
   - **Create Post → Publish…** is separate and unchanged: it publishes one post from every eligible
     profile.
   - For Repost or Comment, choose posts from Post Links (**Select all** works here too). For
     Comment, also choose saved comments, or write one.
   - Up to 300 posts or post links per campaign.
4. **Run time:** **Now**, or **at a date and time**, including tomorrow or any later date, in this
   computer's time zone. The time is stored in UTC. For reposts and comments it becomes the task's due
   time.

**Run campaign** starts it at once, with no date or time to enter for each post, comment or repost.

- Nothing is scheduled item by item. Posts from one account are spaced by the queue (Settings →
  Automation), and X's limits and the account checks still apply.
- A second click while it starts is ignored.
- The same campaign sent again while it is still running is refused.

Blocking problems are shown above the button, for example:

- no posts;
- a post that is already scheduled or published;
- no usable profile;
- a time in the past.

**While it runs**, the campaign shows **Running**, **Completed** or **Failed** and a progress bar.

- **Each operation** records:
  - the account and profile;
  - the post;
  - its time;
  - the result: published (with **View on X**), failed with the reason, needs review, or waiting.
- **Results per post:** each selected post shows *Published on N of M accounts*, with how many are
  waiting, publishing, failed or need review.
- **One account failing never stops the others.** Its post fails with the reason. If it is signed out,
  its other waiting posts are put on hold rather than failing one by one, and are released once the
  sign-in is fixed. Failed posts can be retried one by one.
- **Never twice:** a selected post is planned at most once per account in a campaign (database
  constraint, migration `014`), each post has one task (idempotency key), and a campaign resumed
  after a restart reuses the copies and schedules it already made.
- **Comments** have their own line under each post: waiting, posting, posted (with **View comment**),
  failed, or needs review.
- **Completion:** a campaign is *Completed* only once every post and every comment has an outcome.
- **Stop** cancels the posts and comments that haven't started. The posts go back to your saved posts.

**Further down the page:**

- **Needs your attention:** posts and comments X didn't confirm (check whether they went out; never
  retried blindly), failed ones with **Retry**, and **Resume publishing** if publishing was paused.
- **Recent campaigns:** open one to see its results.

## How it works underneath

**Publishing:**

- Campaigns and Create Post use the existing automation runs, scheduled posts and the persistent task
  queue: one post at a time per profile, with spacing from Settings → Automation. No second
  scheduling system exists.
- A scheduled post or campaign goes out while X Auto is running, even with its window closed. A time
  that passed while the app was closed is published late only within the *late posts* window;
  older ones wait for you (see [publishing.md](publishing.md)).
- IX Browser opens a profile only when its post is due, and closes it afterwards. The engine checks
  the signed-in account (when the username is confirmed), posts, and confirms the post link.
- **A comment** is a `reply` task, queued in the same transaction that records the confirmed post.
  - The idempotency key is `reply:<publish task id>`, so there is one reply per post, even after
    restarts or retries.
  - It carries the parent post's id from X's confirmed link.
  - It uses the same profile and the same checks, and X's documented post web intent
    (`/intent/post?in_reply_to=<id>`).
  - It is never posted for a post that failed or wasn't confirmed, and never to anyone else's post.

**Data** (migration `013`):

- `drafts.comment_text` and `comment_enabled` hold the comment.
- `browser_profiles.link_excluded_at` and `disconnected_account_id` record a disconnect.
- `profile_sync_runs.linked`, `link_failed` and `link_errors` record what automatic linking did.

Nothing existing was removed or rewritten.

**Old addresses still work** (bookmarks, notifications):

| Old address | Now opens |
| --- | --- |
| `/posts` | Create Post |
| `/generator` | Create Post in AI mode |
| `/automation` | Campaigns |
| `/automation-schedule` | Campaigns |
| `/scheduler` | Campaigns, at Scheduled posts |
| `/queue` | Campaigns, at the Posting queue |
| `/accounts` | Synchronized Profiles (profiles first; `?view=accounts` for the X accounts tab) |

**Bulk posts and comments:**

- The paste is parsed in `src/shared/lib/bulkParse.ts`, and checked again by the main process.
- Posts become ordinary `drafts` rows. Comments go in `comment_drafts` (body, optional target link,
  position, used time). Both tables come from migration `016`, which only adds tables.
- Each bulk save writes one `bulk_saves` row (its request id and result) in the same transaction as
  the items. A repeated request id returns that result.
- Saved comments in a campaign are `reply` queue tasks like any campaign comment (idempotency key
  `engage:<task id>`). The preview and the start use the same pairing (`pairComments`).

## Verification status

- **Verified:**
  - Unit suites with the real services and database, the IX Browser contract mock and a scripted
    engine (`tests/unit/autolink.test.ts`): automatic linking, duplicates, disconnect/reconnect,
    missing profiles, link failures and retry, publishing without account selection, comments,
    scheduling, campaigns, failures and review.
  - Engine tests in real Chrome against the local X stand-in, including the reply composer and finding
    an unconfirmed reply.
- **Not verified:**
  - A real IX Browser installation.
  - Publishing or replying on x.com. X's web selectors and the intent page are not a documented
    automation interface and can change.
  - A clean Windows install.
