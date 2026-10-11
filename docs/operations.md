# Automation controls, notifications, usage and backups (Phases 10 + 11)

## Automation controls (Campaign Automation → posting queue → control centre)

- **State**: Running (a task is in progress), Ready (nothing due) or Paused. Also shown in the
  status bar.
- **Pause**: no new task starts; a running post finishes normally. The paused state is saved and
  survives a restart (the user is reminded at start-up). Scheduled slots keep turning into queued
  tasks while paused.
- **Resume**: posts whose time passed long ago while paused are not sent late — like slots missed
  while the app was closed, they become *missed* and wait for the user.
- **Stop now** (with confirmation): pauses, and the running task stops at its next safe point —
  before anything is submitted. It goes back into the queue and the interrupted attempt doesn't
  count. If IX Browser was still opening the profile, the profile is closed again when it opens.
  A post already being submitted cannot be called back, and the dialog says so.
- **Hold / Release** a waiting task: it stays queued but is never started until released.
- One worker per task (conditional claim in SQLite), at most one task per account; queued and
  interrupted tasks are recovered after a restart (an interrupted publish becomes *needs review*).

## Errors and notifications

The UI shows plain-language notices only — no log screen, raw error text, codes, paths or stack
traces. Detailed, redacted logs are kept internally; **Settings → Security & app info → Diagnostics
file for support** saves them (keys, passwords, cookies and tokens removed).

| Event | Notice |
| --- | --- |
| Post published / failed / may have been posted | "Post published", "A post could not be published", "Publishing outcome needs review" |
| Scheduled post missed while the app was closed | "A scheduled post was missed" |
| IX Browser not reachable during publishing | "Connection to IX Browser failed" (posts are retried) |
| Engine crashed repeatedly | "Automation stopped" — with what to do |
| Usage limit at 80% / 100% | "Usage limit almost reached" / "Usage limit reached" |
| Automatic backup done / failed | "Backup completed successfully" / "Automatic backup failed" |
| Reminder before a scheduled post | "Post going out at 14:30" |

The same continuing problem is announced once (per account and error, per 30 minutes by
default; IX Browser and engine problems until they recover). Each notice goes to the in-app
notification centre and, if enabled for that event type in Settings → Notifications, to a desktop
notification. Retries: only failures that happened before anything was submitted, up to
*attempts* (default 3), waiting *retry delay* (default 1 min) then 5× longer each time, at most an
hour. Anything that may already have taken effect is never retried automatically.

## Settings

Application: General · Appearance · Notifications · **Automation** (engine status in plain words,
publishing preferences, engagement guideline). Connections: **AI providers & keys** (text and image
providers, keys masked and write-only, connection tests, default provider and model) · **IX
Browser** · **Proxies** (summary, default proxy; managed in Accounts & Profiles). Data: **Usage &
costs** · **Backup & restore**. System: **Security & app info** (isolation, key storage, data check,
compact, diagnostics file, version). Old links (`?section=providers`, `database`, `image`, `about`,
`publishing`) open the section they were merged into. No X API key is ever asked for.

## Usage & costs

- Every recorded AI request (`ai_usage`): provider, model, request type, time, outcome, tokens and
  image counts **exactly as the provider reported them**.
- Totals and breakdowns by day, month, provider and request type for Today / 7 days / 30 days /
  This month / a custom range, filterable by provider; plus the request history.
- **Costs are estimates from rates you enter** (per provider, optionally per model: per 1M input
  tokens, per 1M output tokens, per image). The OpenAI API responses used here carry no price, so
  without rates no cost is shown, and requests that can't be priced (no rate, or no usage
  reported) are counted as "not priced".
- **Limits** (optional; per provider or all; per day or month; on requests, tokens, images or
  estimated cost): a notice at 80% and 100%, and with *block* new text/image generation requests
  are refused (with a plain reason) until the period ends or the limit changes. Connection tests
  still work.

## Backup & restore

- **One file** (`.axrbackup`, a gzip-compressed tar) holding the database (drafts, schedules, the
  task queue, post links, engagement tasks, accounts, usage history, settings, logs) and the image
  library, plus a manifest with every file's SHA-256.
- Written to a temporary `.partial` file, then **read back**: every file's checksum must match and
  the database must pass SQLite's integrity check — only then is it renamed and reported done.
  Free space is checked first. Two backups in the same second never overwrite each other.
- **Destination folder** of your choice; **automatic backups** daily or weekly while the app runs,
  keeping the newest N (manual backups are never pruned).
- **Restore**: the file is checked completely first (checksums, database) without touching current
  data; you see what it holds and must confirm. Publishing pauses, a **safety backup** of the
  current data is made (no restore without it), images are swapped in, then the database; if any
  step fails, the previous images and database are put back. Older `.sqlite` backups (Phase 2)
  still restore (database only). Only one backup or restore runs at a time.
- **Not included**: API keys and proxy passwords (encrypted with this computer's user account; on
  the same computer they keep working after a restore, on another one they must be entered again),
  and IX Browser profiles, cookies and sessions (kept by IX Browser).

## Verification

- Unit: 29 checks (pause/resume/stop/hold, retry delays, usage report, rates, limits) and 32
  backup checks (archive round trip, verify, restore, safety backup, rollback on failure, damaged /
  truncated / foreign files, legacy backups, automatic schedule and pruning).
- End-to-end: 43 checks in the real app with the real engine and Chrome, the IX Browser and
  OpenAI contract mocks, and real backup files (unpackable with the system `tar`).
- Not verified here: desktop notifications on Windows; backups on a Windows file system.
