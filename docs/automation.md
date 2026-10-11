# Creating posts and running campaigns

Automation lives in two tabs:

- **Create Post** for writing posts.
- **Campaign Automation** for posting them on a schedule.

Dashboard, Accounts & Profiles, Post Links and Settings are separate and unchanged.

## Create Post

Create Post is one page with an **AI Post / Manual Post** toggle. Saved posts are listed on the left.

| | |
| --- | --- |
| **AI Post** | Describe the topic, main message, audience, tone and length, choose the AI provider and model, and generate variations. **Use this post** opens one in the editor (**Save for later** keeps it without opening). Facts in the brief are the only facts the AI may use. |
| **Manual Post** | Type the post yourself. No AI provider is needed. |

**The editor** is the same for both modes:

- text, hashtags and the X length meter;
- images: **Upload**, **Library**, or **Generate** with the image provider;
- AI editing tools (optional) and a preview;
- **Save**.

**For a saved post:**

- **Publish now…** asks for **All accounts** or **Select accounts**.
  - All accounts means every account linked to an available IX Browser profile.
  - Every chosen account is checked first, and at least one account is required.
  - Posting the same text from several accounts has to be allowed with an explicit switch. Each
    account gets its own copy of the post.
  - After sending, the dialog follows each account live: waiting, publishing, published (with
    **View on X**), failed, or needs review.
- **Use in a campaign** opens Campaign Automation with the post already selected.

A post that is already scheduled, published or failed shows its status strip in the editor, with
actions such as changing the time, publishing now, cancelling or returning it to drafts. Posts
scheduled before this layout existed stay manageable there.

## Campaign Automation

Campaign Automation is the one page for automated posting.

1. **Posts.** Choose saved posts (AI or manual) in the order they should be used. Each is posted
   unchanged. If you have none, **Create a post** opens Create Post.
2. **Accounts.**
   - **All profiles** or **Selected profiles** (search, Select all / Deselect all), with live counts
     such as "5 selected · 4 available · 1 unavailable".
   - Different posts per profile, or the same posts on every profile (repeated content must be
     allowed explicitly).
   - Accounts are checked before posting.
3. **Schedule.**
   - Start now, or at a date and time.
   - End: no end, at a date and time, or after a number of days.
   - **Posting days**, optional **posting hours**, minutes between posts per account, posts per
     account, and the most posts in the campaign.
   - Slots follow each other: each is the first allowed moment at least one interval after the
     previous one, so an account never gets two posts at the same time.
4. **How posts go out.**
   - **Automatically**: each post is published at its time.
   - **After my approval**: each post waits; you can approve, edit or remove it.
   - **More options** covers unavailable accounts, pausing after failures in a row, and repost,
     comment and like *tasks* (done by you, never automatically).
5. **Before you start.** A live summary shows eligible profiles, posts, timing, the enabled actions,
   warnings and blocking problems. **Start campaign** asks once to confirm.

**While a campaign runs**, its panel shows:

- status and progress;
- every post with its account and next posting time, published links, and errors;
- **Pause**, **Resume** and **Stop**, plus a switch between automatic and approval.

**Further down the same page:**

- **Campaigns:** past and current campaigns; open one to see its details.
- **Recurring campaigns:** campaigns created earlier that run once per chosen day keep running.
  You can pause, resume or delete them here.
- **Scheduled posts:** single scheduled posts and missed slots. Each opens in Create Post.
- **Posting queue:** every post being published, one account at a time.
  - Pause, resume or stop all automation.
  - Posts that need a review (publishing outcome unknown), failures and retries.
  - Hold and release, and the history of each task.

**Saved setups** (from the page header) keep a campaign's posts, accounts and schedule for reuse,
and start from the dashboard's quick-start buttons. A setup saved before this layout that wrote
posts with AI is loaded with its accounts and schedule, and a note explains that posts are now
created in Create Post.

## How it works underneath (unchanged)

**Publishing:**

- Campaigns run on the existing automation runs, and single posts on the publishing queue.
- IX Browser opens a profile only when its post is due, and closes it afterwards. The engine checks
  the signed-in account, posts, and confirms the post link.
- If X shows no confirmation, the engine looks for the post on the profile before asking you; it
  never retries blindly (see [publishing.md](publishing.md)).
- Posts only go out while X Auto is running.

**Data:**

- Nothing was deleted by the consolidation. Drafts, accounts, campaigns (runs), saved setups
  (presets), recurring campaigns and schedules are all kept.
- Migration `012` added posting days to the campaign schedule (default: every day), the recurring
  schedules table, and the link from a campaign post to the saved post it came from.

**Old addresses still work** (bookmarks, notifications):

| Old address | Now opens |
| --- | --- |
| `/posts` | Create Post |
| `/generator` | Create Post in AI mode |
| `/automation` | Campaign Automation |
| `/automation-schedule` | Campaign Automation |
| `/scheduler` | Campaign Automation, at Scheduled posts |
| `/queue` | Campaign Automation, at the Posting queue |

## Verification status

- **Verified end to end:**
  - The real app, the bundled Python engine and real Chrome, with three Chromes as three profiles'
    browsers.
  - A local stand-in for X's composer and profile pages.
  - IX Browser's Local API and OpenAI as contract mocks.
- **Not verified:**
  - A real IX Browser installation.
  - Publishing on x.com. X's web selectors are undocumented and can change.
  - A clean Windows install.
