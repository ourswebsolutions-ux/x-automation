# AI automation (Phase 12)

The **Automation** page (Automate → Automation, or *Create automation* on the dashboard) turns one
description into a run: Axora Relay writes the posts, optionally generates and attaches an image for
each, assigns them to IX Browser profiles, and publishes them through the profiles' own signed-in
sessions. You confirm once, before the run starts.

## Modes

| Mode | What happens |
| --- | --- |
| **Full Auto** (default) | Generate → attach image → save draft → schedule → publish → verify. No confirmation per post. |
| **Manual Approval** | Generate → attach image → wait. Each post can be approved, edited (opens the editor), regenerated or removed. *Approve all* approves the rest. |

The mode can be switched while a run is active. Switching to Full Auto approves what is waiting.
Switching to Manual Approval makes posts generated from then on wait. Posts already scheduled stay
scheduled. Nothing is deleted either way.

## The wizard

1. **What to post**: choose where the posts come from:
   - **Generate with AI**, or your own fixed text.
   - **My drafts**: your existing drafts (status draft or ready, not scheduled), posted in the order
     you picked them, text unchanged, with no AI request.
   - **My drafts + AI**: your drafts fill the first posts, and AI writes the rest.

   Image generation, when on, only adds an image to drafts that don't have one. With "same posts on
   every profile", the first profile posts the draft and each other profile gets an independent copy.
   For generated posts, you set: instructions, topic, language, tone, length, hashtags, extra instructions,
   the text provider and model. You can also turn generation off and post your own text. Images
   can come from an image provider (style, size) or from a library image attached to every post.
2. **How posts go out**: Full Auto or Manual Approval.
3. **Profiles**
   - **All profiles** (default) means every synced profile, never a guess.
     - If nothing is synced, the run can't start.
     - A failed or empty sync never counts as "all".
   - **Selected profiles** has search, *Select all* and *Deselect all*, an availability badge per
     profile, and *Refresh*.
   - The counts ("5 selected · 4 available · 1 unavailable") update live.
   - Distribution options:
     - Different posts per profile.
     - The same posts on every profile. This is off unless repeated content is allowed.
     - Drafts only.
   - **Check the signed-in account before posting** is on by default. Only accounts with a
     confirmed X username are used, and the engine checks the profile is signed in to that
     username before it posts.
4. **Actions**: publish, save drafts, repost, comment, like (see *Engagement* below).
5. **Timing**
   - Now or a start time, with an optional end time.
   - Minutes between posts per profile, posts per profile, maximum posts per run.
   - Working hours.
6. **When something goes wrong**
   - Extra generation attempts.
   - Text failure: skip or pause.
   - Image failure: pause, skip the post, or publish without the image. The last applies only
     when chosen.
   - An unavailable profile: leave it out, or don't start.
   - Pause after N failed posts in a row.

The **Before you start** panel shows the plan as you edit:

- Eligible profiles out of those selected, and posts, images and timing.
- The enabled actions.
- Warnings and blocking problems.

*Start automation* opens one confirmation, and then the run starts.

**Presets** save every setting on the page. You can load them from the page header or start one
from the dashboard.

## Automation Schedule (recurring)

The **Automation Schedule** page (Automate → Automation Schedule) is separate from the schedules of
individual posts. A schedule has these settings:

- A name.
- The automation settings, taken from a preset or the Automation page and copied when saved.
- A start date and an optional end date.
- The days of the week.
- Daily hours (from–until, on the same day).

On each chosen day inside the date range, it starts **one** run:

- The posts are spread inside that day's hours. "Posts per profile" means per day.
- It runs only once per day, and only one automation runs at a time. If another run is active, it
  waits and starts when that run is free, as long as the hours are still open.
- If the app was closed through the whole window, that day is not made up later. The schedule shows
  a note saying so.
- If a start is refused (for example, no synced profiles), you get one notification and the reason
  is shown on the schedule.
- **Pause** stops new days and also pauses that schedule's run in progress. **Resume** reverses both.
- After the end date the schedule shows *Ended*. Changing the date reactivates it.
- Recurring schedules always generate new posts. A fixed set of drafts, or the same fixed text every
  day, is refused.

## What a run does

- Posts are generated in small batches. Each text is checked against X's length limit and against
  every other text in the run, so no duplicates are posted.
- The prompt asks for original content, no invented facts, statistics or quotes, and no
  impersonation.
- **Images**
  - The image prompt is written from the post text, and the image is generated and validated by its
    content.
  - The image is saved in the image library and attached to the draft.
  - An image counts as "attached" only when the draft really holds it.
  - Images survive restarts, because the draft and the library keep them.
- **Full Auto**: posts go to the existing publishing queue (one post at a time per account, with
  spacing) at their time slots.
- **Manual Approval**: posts wait for approval.
- **Publishing** (see [publishing.md](publishing.md)):
  - IX Browser opens the profile, and the engine checks the signed-in account and posts.
  - The engine confirms the post from the link X shows.
  - **If the post may have gone out but X showed no confirmation**, the engine checks the
    account's profile page for the exact text:
    - Found: the post is recorded as published, verified by the profile check.
    - Not found: the post goes to **needs review** and is never retried on its own.
- **Pause** stops new generation and pauses the publishing queue, so no new post starts. It is the
  same pause as in the Task Queue. **Resume** continues.
- **Stop** ends the run:
  - Posts waiting for their time are cancelled and returned to your drafts.
  - Posts waiting for approval are kept as drafts.
  - A post being published right now finishes.
- **Restart**: an app closed mid-run resumes as *paused* (generation) or keeps waiting
  (approvals). Scheduled posts stay in the persistent queue.
- **Posts only go out while Axora Relay is running.** Missed slots are handled as described in
  publishing.md.

## Engagement

Reposts, comments and likes are **planned as tasks you complete yourself** in the profile
(Post Links → Engagement):

- One task per account per post per kind, only for the actions you turned on.
- Comment text is the text you wrote.
- The existing guardrails against self-amplification, coordinated and duplicate engagement and the
  daily limit apply.

Axora Relay does not like, repost or reply automatically. X's rules prohibit artificial or
coordinated engagement, and automated replies can't be made genuinely original for posts the app
hasn't read.

## Notifications

A run reports in plain words, with no codes or technical details:

- "Automation started"
- "4 posts generated and saved" or "… generated with images"
- "4 posts are ready for your approval"
- "Post published"
- "1 profile is unavailable"
- "Publishing outcome needs review"
- "AI provider connection failed. Check settings."
- "Image provider request failed. Check settings."
- "Automation paused", "Automation resumed", "Automation stopped", "Automation finished"

## Data

Migration `011_automation_runs` adds three tables: `prompt_presets`, `automation_runs` (the config
snapshot, status and message) and `run_items` (one row per post or engagement task). A run item
links to its draft, account, image and schedule. Publishing state is read live from the queue, so
the run view always matches the Task Queue.

Migration `012_automation_schedules` adds three things: the `automation_schedules` table,
`automation_runs.schedule_id` (the schedule that started a run) and `run_items.source_draft_id` (the
draft a post came from).

## Verification status

- Verified end to end:
  - The real app, the bundled Python engine and real Chrome, with three Chromes as three profiles'
    browsers.
  - A local stand-in for X's composer and profile pages.
  - IX Browser's Local API and OpenAI as contract mocks.
- **Not verified:**
  - A real IX Browser installation.
  - Publishing on x.com. X's web selectors are undocumented and can change.
  - A clean Windows install.
