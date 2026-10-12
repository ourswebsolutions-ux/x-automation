# Scheduling, queue and publishing (Phase 8)

## What it does

- **Schedule** a draft for one account at a date and time, or **Publish now**. A draft is locked
  (status *scheduled*) while it has an active schedule; *Cancel schedule* returns it to the list.
- **Scheduler** (main process, every 15 s and when the computer wakes up) hands due slots to the
  **task queue**. A slot that passed while the app was closed is published late only within the
  *late posts* window (default 15 min). Older slots become **missed** and wait for the user
  (publish now, new time, or cancel). Queued posts that never started and are now too late are
  withdrawn the same way at start-up.
- **Task queue** (SQLite, survives restarts): one task runs at a time, never more than one per
  account. Posts from one account are kept apart by the *spacing* setting (default 10 min).
- **Publisher**: opens the account's IX Browser profile through the documented Local API
  (`profile-open`, which returns `debugging_address`), attaches the Python engine with Playwright's
  `connect_over_cdp`, opens one tab in the profile's own browser context (its signed-in session —
  no cookies are read or copied), opens `https://x.com/compose/post`, types the post, attaches
  images, clicks **Post** once, and waits for the post link X shows afterwards. The tab is closed;
  the profile is closed again if X Auto opened it (setting).
- **Post links**: every confirmed post is saved with its X post id and handle.
- **Notifications**: published, failed, needs attention, missed, reminders — plain language, in
  the notification centre and (if enabled per event type) as desktop notifications. A continuing
  failure is reported once per 30 minutes.

## Never posting twice

| Situation | Outcome |
| --- | --- |
| Failed before the Post button was clicked (profile would not open, engine/CDP connection failed, composer did not load, upload did not finish) | Safe: retried automatically with backoff (1, 5, 15 min) up to *attempts* (default 3) |
| Signed out of X, a different account signed in, the composer did not take the text exactly, Post button disabled | Failed, nothing posted, not retried |
| Post clicked, X confirmed with a post link | Published; link saved |
| Post clicked, X showed a notice without a post link | Failed ("X did not accept the post"), not retried |
| Post clicked, no confirmation in 45 s, and the account's username is confirmed | **Profile check** (Phase 12): the engine opens `x.com/<username>` and looks for the exact text among the latest posts. **Found:** published, with the link saved and the result marked *verified by profile check*. **Not found, or the check failed:** needs review (below) |
| Post clicked, no confirmation and no profile check possible; engine crashed or timed out after the click; app closed during a publish | **Needs review**, never retried. The user checks X and marks it *posted* (optionally with its link) or *not posted* (and may then retry) |

**One post from every synchronized profile:**
- **Publish…** in Create Post publishes now or schedules the post from every eligible account: an
  enabled account on a profile IX Browser still reports. The main process decides which accounts
  (`publishing.targets`); there is no account selection.
- Every account is checked before anything changes.
- The draft goes to the first account. Each other account gets an independent copy with the same
  text, images and comment, so each post has its own schedule, task and link.
- The same text from several accounts must be allowed explicitly with a switch, because X can treat
  it as repeated or coordinated content.

## Comments (replies to your own post)

A post can carry a comment (Create Post → Comment). It is posted after the post, never instead of it:

| Situation | Outcome |
| --- | --- |
| The post is confirmed with its link | A `reply` task is queued in the same transaction (idempotency key `reply:<publish task id>`). The same account opens X's post web intent `/intent/post?in_reply_to=<post id>` in the same profile, types the comment, clicks **Reply** once and waits for X's link |
| The post failed, or was never confirmed | No comment is queued |
| The post was confirmed by you without its link | No comment (there is nothing to reply to); a notice asks you to post it yourself |
| The comment fails before submitting (composer didn't load, profile didn't open) | Retried with the usual backoff, then failed with a plain reason. The post stays published |
| Submitted, no confirmation | The engine looks for the comment on the account's **Replies** tab (confirmed usernames only); otherwise *needs review*, never retried blindly. Confirming it in the review dialog records only the comment |
| Signed out, wrong account, text not taken | Failed, nothing posted (the same checks as for posts) |
| A campaign is stopped | Comments that haven't started are cancelled |

A comment only ever answers the account's own post, which it just published. It is never sent to
anyone else's post or from another account.

How this is enforced:

- One schedule slot → one task (`idempotency_key` UNIQUE). A task is claimed with a conditional
  `UPDATE … WHERE status = 'queued'`, so it cannot run twice at once.
- The engine reports progress stages (`attach`, `open-composer`, `write`, `upload-media`,
  `submit`, `confirm`). It writes `submit` before clicking, and the app reads the engine's output
  completely (`close` event) before reacting to a crash, so "did it reach the click?" is always
  answered conservatively. Every engine failure carries `submitted: true|false`.
- If the app stopped while a publish task was running, the task becomes *needs review* on the
  next start — it is never re-run on its own.
- A task with a saved post link is never published again.
- Before typing, the publisher reads the @handle shown in X's side navigation; if the account
  record has a **confirmed** username and a different account is signed in, nothing is posted.

## X web app selectors — not a documented interface

X documents no automation interface for its web app. The publisher relies on these `data-testid`
attributes, kept in one place (`engine/axora_engine/x_publish.py`, `SELECTORS`):

`tweetTextarea_0` (composer), `tweetButton` (Post), `fileInput` (images), `attachments`,
`SideNav_AccountSwitcher_Button` (signed-in handle), `toast` (confirmation with the post link),
`loginButton` (signed out), and for the profile check, `article[data-testid="tweet"]` and `tweetText`.

If X changes them, publishing fails **before** clicking Post (composer not found, button not
enabled) or ends in *needs review* — it does not report a false success.

## Verification status (2026-10-10)

| Item | Status |
| --- | --- |
| Queue, scheduler, recovery, retry rules, spacing, reminders, missed slots | Verified: 59 unit checks, 56 end-to-end checks in the real app |
| Publisher logic (one click, outcomes, `submitted`, images, signed-out, wrong account, text check, tab closed) | Verified against a **local stand-in** for X's composer (`engine/tests/x_fixture.py`) in a real Chrome over CDP: 10 engine tests + the end-to-end suite |
| Publishing on **x.com** | **Not verified** — no X account or IX Browser is available on the development machine. The selectors above match the X web app as known at the time of writing |
| Image descriptions (alt text) | Not applied when publishing; the schedule dialog warns when a draft has them |
| Posts longer than 280 characters | Allowed with a warning; only X Premium accounts can publish them, and X decides |

The stand-in and the test-only `baseUrl` are accepted only in development runs that set
`AXORA_TEST_X_BASE_URL`; the engine additionally requires `AXORA_ENGINE_TEST_TARGETS=1`, which
the app sets only in that case. Packaged builds always publish to `https://x.com`.
