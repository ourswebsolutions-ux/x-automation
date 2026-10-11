# X Auto

Windows desktop workspace for managing X accounts, drafts, scheduling and automation.
Built with Electron, React, TypeScript, Vite (electron-vite) and Tailwind CSS.

**Status: Phase 12, not fully verified.** Automation lives in two tabs:
- **Create Post:** write a post yourself or with AI (AI Post / Manual Post), add images, preview and
  edit it, then **Publish now** to all or selected accounts (with live progress), or **Use in a
  campaign**.
- **Campaign Automation:** choose saved posts and accounts, set the schedule (start, end or
  duration, posting days and hours, interval, limits), review, and **Start campaign**. Then pause,
  resume or stop it and follow its status, next posting times, published posts and errors. The
  posting queue (needs-review, retries, hold) and earlier recurring campaigns are on the same page.

Dashboard, Accounts & Profiles, Post Links and Settings are unchanged.
See [docs/automation.md](docs/automation.md).
Phases 8–11 added:
- Scheduling and publishing through IX Browser profiles with a crash-safe task queue
  ([docs/publishing.md](docs/publishing.md)).
- Post-link management with compliant engagement tasks ([docs/engagement.md](docs/engagement.md)).
- Automation controls, notification-only error handling, usage and cost tracking, and verified
  backup and restore ([docs/operations.md](docs/operations.md)).

**Not yet verified:**
- Publishing on x.com. It is verified only against a local stand-in for X's composer in real Chrome.
- Anything against a real IX Browser installation.
- Building and testing the Windows installer on a clean machine.

Pre-Phase 8 (automation engine & proxies): Browser automation runs in a
bundled **Python + Playwright** engine that the app starts, supervises and stops by itself
(no server to run, no Python to install). A proxy manager stores proxies (passwords in the OS
vault), tests them for real, and applies them to IX Browser profiles through IX Browser's
documented API. See [docs/automation-engine.md](docs/automation-engine.md).
**Not yet verified:** attaching to a browser launched by a real IX Browser installation (only
tested against Chrome with a contract mock of the Local API), IX Browser accepting the
custom-proxy action, and installing on a clean Windows machine. Automation must be treated as
unverified until a profile's compatibility check passes against real IX Browser.
Phase 7 (images & attachments): Drafts can carry up to four images (or one
animated GIF): uploaded from disk, picked from the local image library, or generated with an
image provider (OpenAI Images API). Files live in an app-managed folder; SQLite keeps metadata.
Phase 6 (tweet generator & editor): Drafts are written, edited, searched,
filtered, duplicated and deleted in Create Post — no AI provider needed. The AI
generator and ten AI editing tools run through the Phase 5 AI service, and every request
is kept in a generation history.
Phase 5 (AI providers): OpenAI and OpenAI-compatible providers can be added,
tested with real requests, and used through a typed text-generation service; every AI
request is recorded with provider-reported token usage.
Phase 4: local X account records can be created,
linked to synchronised IX Browser profiles, searched, filtered, enabled or disabled for
future task assignment, and removed — without ever touching the browser profiles.
Phase 3 synchronises profiles from IX Browser's Local API V2 and opens/closes them.
Phase 2 stores drafts, settings, provider configurations and logs in a local SQLite
database, with API keys encrypted by the operating system. AI providers, publishing and
scheduling are configurable but **not connected** yet, and the interface says so.

## Commands

| Command | What it does |
| --- | --- |
| `npm install` | Install dependencies |
| `npm run dev` | Start the app with hot reload |
| `npm run typecheck` | Strict TypeScript checks (main/preload and renderer) |
| `npm run build` | Typecheck, then build main, preload and renderer into `out/` |
| `npm run preview` | Run the production build |
| `npm run release -- 1.0.1` | One-command release: checks, tests, version, tag, push, then waits for the native Linux/Windows/macOS builds and verifies the published GitHub Release and its auto-update metadata ([docs/release.md](docs/release.md)) |
| `npm run dist:linux` | Build the Linux AppImage and .deb into `release/<version>/` |
| `npm run dist:win` | Build the Windows NSIS installer into `release/<version>/` (run on Windows) |
| `npm run dist:mac` / `dist:mac:x64` | Build the macOS arm64 / Intel .dmg and .zip into `release/<version>/` (run on a Mac) |
| `npm run dist:dir` | Build an unpacked app for the current OS (quick packaging check) |
| `npm run engine:prepare -- --platform=win\|linux\|mac` | Download the pinned, checksum-verified Python runtime and install the hash-locked engine dependencies into `engine-runtime/<platform>/` (build machines only) |
| `npm run engine:test` | Run the engine's Python tests with the bundled runtime (attaches to a real Chrome/Chromium for the CDP test when one is installed) |

> If you launch from a shell that has `ELECTRON_RUN_AS_NODE=1` set (some editor
> extension hosts do), Electron starts as plain Node and the window never opens.
> Unset it first: `env -u ELECTRON_RUN_AS_NODE npm run dev`.

## Architecture

```
src/
  shared/                 Code imported by every process. Types only, no Node or DOM APIs.
    types/                Domain model, integrations, preferences, system info
    ipc/                  Channel names, the RelayApi contract, the IpcResult envelope
    config/               App constants, default preferences, route ids
  main/                   Electron main process
    index.ts              App lifecycle, single-instance lock, event wiring
    window.ts             BrowserWindow factory and SECURE_WEB_PREFERENCES
    security/             Navigation, window-open, webview and permission guards; sender trust
    ipc/                  Router (sender check, zod validation, error envelope) and handlers
    services/
      container.ts        Composition root: swap implementations here
      database/           driver.ts (node:sqlite adapter), migrations/, migrator, DatabaseService
                          (open, health, compact, online backup, validate, restore), sqlite/ repositories
      preferences/        SQLite-backed preferences (per-key validation) + one-time Phase 1 import
      credentials/        SafeStorageVault: OS-encrypted vault file, never touches SQLite
      providers/          Provider configs, write-only keys, readiness rules
      accounts/           AccountService: account records, profile links, local history
      generator/          GeneratorService, prompt builder, result parser (Phase 6)
      assets/             AssetService (image library, atomic writes, sweep), imageInfo (content sniffing)
      images/             ImageService: image generation + prompt suggestions (Phase 7)
      engine/             EngineService (Python engine supervisor), AutomationService (compatibility checks)
      proxies/            ProxyService, proxy formats (TXT/CSV), real connectivity tester (HTTP CONNECT, SOCKS5, TLS)
      ai/                 AiService, adapters (OpenAI Responses, Chat Completions), error
                          classification, endpoint guard (private-network / DNS checks)
      backup/             Native-dialog backup/restore, restore tokens, recovery backups
      logging/            Structured logger → SQLite, metadata sanitising, redaction, export
      drafts/             DraftService
      workspace/          Dashboard read model
      integrations/       IX Browser, AI text and image provider boundaries, status aggregation
      scheduling/, queue/ Scheduler and TaskQueue contracts (Phase 8)
  preload/                Exposes the typed `window.relay` bridge. Nothing else crosses over.
  renderer/src/
    app/                  Router (hash-based) and navigation config
    layout/               Shell: title bar, sidebar, status bar, command palette, notifications
    components/ui/        Design-system components (one barrel: `@/components/ui`)
    components/feature/   Shared feature pieces (phase placeholder, wireframes, length meter)
    pages/                One folder per section
    state/                Preferences, system info, notifications, overlay state
    data/                 Demo dataset (clearly marked) and data hooks
    hooks/, lib/          Utilities (async state, hotkeys, formatting, X length counting)
    styles/               Design tokens (tokens.css) and Tailwind theme (index.css)
```

### How data flows

`renderer → window.relay (preload) → ipcRenderer.invoke → IPC router → service → repository`

Every invoke handler checks that the sender is our own renderer, validates the
payload with zod, and returns an `IpcResult` envelope so errors arrive intact.

### Data layer

- **Engine:** Node's built-in `node:sqlite` (SQLite 3.53, bundled with Electron 44's Node
  runtime). No native module to compile for Windows. It is still flagged experimental in
  Node 24 (a warning is printed to the terminal); all access goes through
  `database/driver.ts`, so switching to `better-sqlite3` later touches one file.
- **Location:** `<userData>/data/relay.db` (on Windows: `%APPDATA%\X Auto\data`).
  WAL journal, foreign keys enforced, unknown SQL parameters rejected.
- **Migrations:** append-only list in `database/migrations/`. Each runs in a transaction
  with its bookkeeping row (`schema_migrations`, with a checksum) and `PRAGMA user_version`.
  Files carry `PRAGMA application_id = 'AXRY'`; foreign or newer-schema files are refused.
- **Startup recovery:** an unreadable database is renamed `relay.db.unreadable-<time>`
  (never deleted) and a fresh one is created; Settings → Database explains what happened.
- **Backups:** SQLite online backup API → verified copy. Restore validates the file
  (header, application id, schema version, integrity check, required tables), writes a
  recovery backup to `<userData>/backups`, swaps the file, and rolls back on failure.

### IX Browser integration

Built against the Local API V2 contract used by the vendor's official client
([ixspyinc/ixbrowser-local-api-python](https://github.com/ixspyinc/ixbrowser-local-api-python)):
`POST http://127.0.0.1:53200/api/v2/<action>` with a JSON body; responses use the envelope
`{ "error": { "code", "message" }, "data" }` (code `0` = success). No API key — the Local
API is enabled inside the IX Browser desktop client.

| Action | Used for |
| --- | --- |
| `profile-list` (`page`, `limit`) | Connection test (page 1, 1 item) and paginated sync (100 per page) |
| `profile-opened-list` | Profiles opened through the Local API |
| `native-client-profile-opened-list` | Profiles opened in the IX Browser app (optional on older builds) |
| `profile-open` / `profile-close` (`profile_id`) | Open / close from Accounts & Profiles |

Cookie, password, fingerprint and transfer-code actions exist in the API and are never
called. Only `profile_id`, `name`, `site_url` and other primitive, non-sensitive fields
are stored (anything resembling credentials, personal data or session state is dropped).
Code: `src/main/services/integrations/ixbrowser/` (typed client, zod response schemas,
service) and `database/sqlite/profileRepository.ts`; schema changes in migration 002.

### X account management

An account is a **local record** (label, optional X username, notes, a local
"available for task assignment" flag) that can be linked to one synchronised profile.

- **Identity is never guessed.** X Auto has no supported way to verify an X identity
  yet, and it does not read anything from browser profiles. A profile name is never used as
  a username. Usernames are `unknown`, `unverified` (entered) or `confirmed` (the user
  explicitly confirmed it — shown as "Confirmed by you", not "verified").
- **One profile, one account.** `accounts.browser_profile_id` is `UNIQUE`; the service and
  the profile picker refuse profiles already linked elsewhere or missing from the last sync.
- **Local only.** Enable/disable, unlink and remove change local records only. Removing an
  account never deletes a browser profile; accounts with scheduled posts or post links
  are skipped rather than cascading those deletions.
- **Profiles that change** during a sync (renamed, no longer reported, back again) keep
  their link, and the change is written to the linked account's history.
- Open/close goes through `IxBrowserService` (Phase 3) — no duplicated API code.

Code: `services/accounts/accountService.ts`, `database/sqlite/accountRepository.ts`,
migration 003 (rebuilds the Phase 1 `accounts` table with foreign keys off, as SQLite's
ALTER procedure requires, then runs `foreign_key_check` before committing), renderer in
`pages/accounts/`.

### AI providers

Built on the official `openai` SDK (pinned 7.23.0). Two adapters, each declaring its
capabilities and parameter limits in `shared/config/aiAdapters.ts`:

| Type | API used for generation | Notes |
| --- | --- | --- |
| OpenAI | Responses API (`POST /responses`, `store: false`) | Usage always reported |
| OpenAI-compatible | Chat Completions (`POST /chat/completions`) | Hosted services or local servers (LM Studio, Ollama on 127.0.0.1); usage when the server reports it |

- **Models are never hard-coded.** They come from the provider's `GET /models`; ids that
  match documented non-text families (embeddings, speech, images) are hidden by default.
  Any id can be typed for servers with partial lists.
- **Connection test** = a real `GET /models` with the saved key (free). "Connected" is shown
  only after it succeeds, and only while the key/endpoint are unchanged.
- **Try a prompt** sends one short, billed request (≤ 500 chars, output capped at 200 tokens),
  cancellable from the UI.
- **Errors** are classified (key rejected, quota, rate limit with Retry-After, model
  unavailable, unsupported parameter, timeout, network, provider error, malformed
  response, cancelled) with messages that never echo the key.
- **Retries:** only for model listing (safe reads). Generation is never retried automatically.
- **Endpoints:** remote must be https; private-network, link-local (cloud metadata) and
  internal names are refused, and DNS answers are re-checked before every request.
  Redirects are not followed. `OPENAI_*` environment variables are ignored.
- **Usage** (`ai_usage`, migration 004): provider, model, operation, status, error kind,
  duration and the provider's token counts (NULL when not reported). No cost estimates —
  no reliable pricing data is configured.
- **For Phase 6:** `services.ai.generateText({ input, instructions?, providerId?, model?,
  temperature?, maxOutputTokens? }, { signal })` returns normalised text, finish reason,
  usage and the usage record id.

### Tweet generator & editor

- **Length rules** (`shared/config/postLimits.ts`, verified 2026-10-10): 280 weighted
  characters ([X docs](https://docs.x.com/resources/fundamentals/counting-characters),
  twitter-text v3 — emoji/CJK count 2, URLs 23, NFC-normalised), or 25,000 for X Premium
  longer posts ([X Help](https://help.x.com/using-x/x-premium)). The app can't see whether
  an account has Premium, so the profile is the user's choice and is labelled as such.
  The counter approximates twitter-text (simpler URL detection).
- **Drafts** (migration 005 adds `hashtags` and `source_generation_id`): text, hashtags kept
  separately and appended when composed, optional account, Draft/Ready status, manual or
  AI-assisted origin. Unsaved edits are guarded when switching drafts or leaving the page.
  Image attachments stay disabled until Phase 7 (`image_assets` already links to drafts).
- **Generator:** topic, key points, audience, tone (7), language, length, 1–5 variations,
  hashtags, CTA, extra instructions. One billed request returns all variations as JSON; an
  answer that can't be parsed is reported as a failure — nothing is invented.
- **AI tools on a draft:** rewrite, improve, shorten, expand, change tone, translate,
  alternatives, hashtags, opening, call to action. Results appear next to the original and
  are applied only when the user chooses "Use this" (then saves) or "Save as new draft".
- **History** (`generations` table): operation, status, provider, model, settings, source
  text, results, linked draft, finish reason, sanitised error, provider-reported tokens, and
  the matching `ai_usage` row. No keys. Any past result can become a new draft.

### Images & attachments

- **X limits** (`shared/config/mediaLimits.ts`, verified 2026-10-10 against
  [media best practices](https://docs.x.com/x-api/media/quickstart/best-practices) and
  [media metadata](https://docs.x.com/x-api/media/create-media-metadata)): JPEG/PNG/GIF/WEBP,
  ≤ 5 MB per image, animated GIF ≤ 15 MB and alone, ≤ 4 images per post, alt text ≤ 1000.
- **Files are validated by content** (magic bytes, header dimensions, truncation, animation) —
  never by extension — and stored as `<userData>/assets/<yyyy-mm>/<uuid>.<ext>` via a synced
  temp file + rename. Duplicates (same SHA-256) are stored once; a missing file is restored
  in place by re-uploading the same image.
- **The renderer never handles paths:** uploads go through a main-process file dialog, and
  images are displayed through `relay-asset://asset/<id>` (ids only, resolved inside the
  asset folder, served with `nosniff`). CSP allows `img-src relay-asset:`.
- **Library:** search, sort, origin filter, preview, details, delete with confirmation.
  Deleting an image a draft uses is refused (service check + `ON DELETE RESTRICT`).
  Generated images not saved or attached are cleaned up after 7 days; orphan/temp files are
  swept at startup.
- **Image generation** (`openai-images` adapter on the Phase 5 AI service, official SDK):
  options per model come from the SDK's documentation of `POST /images/generations`
  (`shared/config/imageModels.ts`) — GPT Image (sizes 1024², 1536×1024, 1024×1536, auto;
  quality auto/low/medium/high; PNG/JPEG/WEBP), DALL·E 3, DALL·E 2; unknown models get one
  square image and no optional parameters. Results are validated before they are shown;
  URL results are downloaded only from public https hosts. Not retried automatically.
- **Prompt suggestion** (optional) uses the AI text provider with a chosen visual style; the
  post text is never changed.
- **Usage:** `ai_usage` rows record image count, size, format, quality and provider-reported
  tokens; `image_generations` keeps prompts, settings and results (migration 006). No costs.

### Automation engine (Python + Playwright)

- `engine/` (Python 3.12, `playwright==1.63.0`, hash-locked) runs as a **child process** of
  the main process and speaks line-delimited JSON over stdin/stdout — no network port.
  Allowlisted commands only; every message validated on both sides; per-request ids and
  timeouts; handshake, health checks, idle stop, crash detection with at most 3 restarts in
  5 minutes, graceful shutdown on quit. The child gets a minimal environment and runs with
  `python -I`, so nothing from the machine's Python setup or environment leaks in.
- It attaches to the browser **IX Browser** launched, via the `debugging_address` that
  IX Browser's documented `profile-open` response returns (`connect_over_cdp`). It never
  launches or downloads another browser, and never creates a new browser context.
- **Compatibility check** (Accounts & Profiles → Browser profiles → a profile): opens the
  profile through the Local API, attaches over CDP, drives a local test page in the
  profile's own context, saves a debug screenshot, closes the test tab and the profile.
- Packaging: `engine-runtime/<os>/` (python-build-standalone CPython 3.12.14, SHA-256
  pinned) and `engine/` are shipped as `extraResources`.
- `npm run engine:test` runs the engine's Python tests with the bundled runtime; when Chrome
  or Chromium is installed it also attaches to a real browser over CDP (otherwise those tests
  are skipped, not faked).

### Proxy manager

Accounts & Profiles → **Proxies**. HTTP, HTTPS and SOCKS5 with optional authentication;
TXT/CSV import (the formats IX Browser's SDK lists, plus `scheme://user:pass@host:port`) and
export (never with passwords). Tests are real: a tunnel through the proxy (HTTP CONNECT or
RFC 1928/1929 SOCKS5) and a certificate-verified TLS handshake with example.com, with latency.
Assignment uses IX Browser's documented `profile-update-proxy-for-custom-proxy` action and is
refused while a profile is open (IX Browser applies proxy settings when a profile starts).
Results are recorded per profile (applied / failed with IX Browser's message); nothing is
retried or rotated automatically. Passwords live in the OS-encrypted vault (migration 007).

### Scheduling, queue & publishing (Phase 8)

Posts are published now (from Create Post) or scheduled by campaigns (Campaign Automation). A
persistent SQLite queue runs one post at a time (one per account, with spacing), recovers after
restarts, and retries only failures that happened before anything was submitted. The Python
engine posts in the profile's own signed-in session through IX Browser and confirms the post from
the link X shows; anything uncertain waits for the user ("needs review") and is never retried on
its own. Details and the selector caveat: [docs/publishing.md](docs/publishing.md).

### Post links & engagement (Phase 9)

Published posts are saved as links; more can be pasted or imported (TXT/CSV), tagged, noted and
exported. Engagement tasks are a checklist the user acts on — X Auto never likes, reposts,
replies or follows by itself — with guardrails against self-amplification and coordinated
engagement. [docs/engagement.md](docs/engagement.md).

### Create Post and Campaign Automation (Phase 12)

**Create Post** combines AI generation and manual writing in one editor, with images (upload,
library or generated), a preview, and publishing to all or selected accounts.

**Campaign Automation** schedules saved posts across accounts on the existing automation runs and
publishing queue, so every post is verified. Repost, comment and like tasks are planned for the
user, never performed automatically. Details: [docs/automation.md](docs/automation.md).

### Automation controls, usage & backups (Phases 10–11)

Pause / resume / stop now and per-task hold in the posting queue (Campaign Automation); plain-language notifications only
(no log screen); usage & cost tracking with user-entered rates and optional limits; one-file
verified backups (database + images) with automatic schedules and safe restore.
[docs/operations.md](docs/operations.md).

### Security

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webviewTag: false`
- A strict Content-Security-Policy in production (`script-src 'self'`, no inline scripts or styles)
- Navigation away from the app and `window.open` are blocked; https links open in the system browser
- All permission requests (camera, microphone, notifications and so on) are denied
- **API keys** are encrypted with Electron `safeStorage` (DPAPI on Windows, Keychain on
  macOS, libsecret/KWallet on Linux) into `<userData>/credentials.vault`. SQLite holds only
  a reference and a 4-character hint, so database backups contain no secrets at all.
  Keys are write-only over IPC and never returned to the renderer. On Linux without a
  keyring (`basic_text` backend) key storage is refused rather than faked.
- **Logs** are redacted (keys, bearer tokens, JWTs, `password=`, cookies) and metadata
  with sensitive key names is dropped before storage and again on export.
- **Files:** the renderer never supplies a path. Backup, restore and export locations
  come from native dialogs in the main process; restores need a short-lived token.

### Design system

All colours, type sizes, radii and shadows are tokens in `src/renderer/src/styles/`.
The default Tailwind palette is turned off, so only token colours can be used.
The dark theme is the reference. The light theme has a complete token set and is
offered as a preview. A new theme only needs to redefine the variables in `tokens.css`.

### Demo data

`src/renderer/src/data/demo.ts` holds sample records for previewing the UI. Every id
starts with `demo-`, every screen that shows them carries a "Demo data" marker, and
the title bar and status bar show when demo mode is on. Turn it off in
Settings → General to see only the real state of this installation.

## Testing

| Command | What it runs |
| --- | --- |
| `npm test` | Unit suites, release tooling tests and engine tests |
| `npm run test:unit` | 14 unit suites on Electron's Node runtime (`tests/unit`) |
| `npm run test:release` | Release tooling: versions, required assets, installer signatures, update metadata, release command safety |
| `npm run test:updates` | Auto-update lifecycle against a local feed (real electron-updater, real UI) |
| `npm run engine:test` | The engine's Python tests |
| `npm run test:e2e` | Builds, then runs the automation end-to-end test (`tests/e2e/automation.e2e.mjs`) |

- **Unit suites** (`tests/unit`): repositories and migrations, IX client, accounts, AI, generator,
  images, proxies, queue and publishing, links and engagement, automation controls and usage,
  backups, automation runs (including drafts as content), recurring automation schedules, and
  application updates.
- **Engine tests**: publishing, finding a post on the profile, and opening posts, all against a real
  Chrome and a local X stand-in.
- **End-to-end test**: drives the real app, the bundled engine and three real Chrome browsers
  against the local X stand-in. IX Browser and OpenAI are contract mocks (`tests/mocks`). Needs
  Google Chrome.

Earlier phases' end-to-end suites were run during development but are not in the repo.
**None of these tests contact x.com or a real IX Browser.**

## Roadmap

| Phase | Scope |
| --- | --- |
| 1 | ✅ Foundation: shell, design system, dashboard, IPC, security |
| 2 | ✅ Database, credential vault, settings, provider management, logs, backup & restore |
| 3 | ✅ IX Browser API integration & profile synchronization |
| 4 | ✅ X account management |
| 5 | ✅ OpenAI & multiple AI provider integration |
| 6 | ✅ AI tweet generator & manual editor |
| 7 | ✅ AI image generation & image attachments |
| pre-8 | ✅ Python + Playwright engine, proxy manager (real IX Browser and clean-Windows checks pending) |
| 8 | ✅ Tweet queue, scheduling & publishing (x.com not verified — no account/IX Browser here) |
| 9 | ✅ Post links & compliant engagement task management |
| 10 | ✅ Automation controls, notifications & error recovery |
| 11 | ✅ API settings, usage tracking & backup/restore completion |
| 12 | 🟡 AI automation (Full Auto / Manual Approval), dashboard, tests in repo. Pending: real IX Browser + x.com verification, Windows installer on a clean machine |
