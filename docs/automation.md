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

The campaign form has four choices and one button.

1. **Action:**
   - **Post** publishes your saved posts.
   - **Repost** plans repost tasks: X Auto opens the post in the profile for you, and you repost
     it. Reposts are never automated, and only one of your accounts gets each post, because several
     of your accounts reposting the same post is coordinated engagement.
2. **Profiles:** **All profiles** or **Select profiles** (search, Select all / Deselect all), with
   live counts. The signed-in X account is always checked before posting; unavailable profiles and
   accounts without a confirmed username are left out.
3. **Posts:**
   - For Post, choose saved posts (AI or manual, from Create Post). They are shared out, one profile
     each, unless you turn on **Post each one from every selected profile** (repeated content, which
     X can limit).
   - For Repost, choose posts from the Post Links library.
4. **Run time:** **Now**, or **at a date and time**. For reposts, the run time becomes the task's
   due time.

**Start campaign** starts it in one click. Blocking problems (no posts, no usable profile, a time in
the past) are shown above the button.

**While it runs**, the campaign shows **Running**, **Completed** or **Failed**, a progress bar, and
the result for each profile and action: published (with **View on X**), failed, waiting, or repost
task for you. **Stop** cancels posts that haven't started; they go back to your posts.

**Further down the page:**

- **Needs your attention:** posts X didn't confirm (check whether they went out, never retried
  blindly), failed posts with **Retry**, and **Resume publishing** if publishing was paused.
- **Recent campaigns:** open one to see its results.

**Removed:** saved setups, end dates and durations, posting days and hours, intervals and limits,
approval mode, recurring schedules, the scheduled-posts overview and the posting-queue table.

- **Recurring schedules** made with an earlier version are kept in the database but no longer start
  runs.
- **Saved setups:** a dashboard quick-start link still opens Campaign Automation with that setup's
  profiles and run time.

## How it works underneath (unchanged)

**Publishing:**

- Campaigns run on the existing automation runs and publishing queue (one post at a time per profile; spacing from Settings → Automation).
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
