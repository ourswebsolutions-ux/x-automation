# Browser automation engine (Python + Playwright)

Status: **pre-Phase 8**. This document records the audit, the migration plan, the
architecture that was built, how it is packaged, how to diagnose it, and what is still
unverified.

## 1. Audit (2026-10-10)

| Area | Finding |
| --- | --- |
| Browser automation in the app | **None.** No Playwright, Puppeteer or CDP code exists in `src/` or `package.json`. |
| IX Browser integration (Phase 3) | HTTP calls to IX Browser's Local API V2 (`profile-list`, `profile-open`, `profile-close`, opened lists). This is profile management, not browser automation, and stays in TypeScript. |
| Node Playwright | Used only by the developer test harness (outside the repo) to drive the app's own UI. It is not part of the product and is not an automation engine. |
| Planned automation | Publishing (Phase 8) and engagement tasks (Phase 9) — not built yet. |

So there was nothing to port: the migration consists of introducing the Python engine as
the **only** browser automation engine and routing all future browser work through it.

## 2. Plan

1. `engine/` — a Python 3.12 package (`axora_engine`) using the official `playwright`
   package. It owns browser connection and page interaction. No network listener.
2. Electron main process — `EngineService` starts the engine on demand as a child process,
   talks to it over **stdin/stdout JSON lines**, supervises it (handshake, health checks,
   timeouts, crash detection, bounded restarts, clean shutdown) and is the only caller.
3. IX Browser — remains the profile manager. The debugging address returned by the
   documented `profile-open` action is passed to the engine, which connects with
   `connect_over_cdp`. A compatibility check verifies the whole path per profile.
4. Proxy manager — proxies stored locally, passwords in the existing OS-encrypted vault,
   connectivity tests in the main process, assignment through IX Browser's documented
   `profile-update-proxy-for-custom-proxy` action.
5. Packaging — a pinned, checksum-verified CPython (python-build-standalone) plus pinned,
   hash-locked wheels are prepared per platform and shipped as `extraResources`.

## 3. Architecture

```
React UI ──IPC──▶ main process
                   ├─ EngineService ──stdin/stdout JSON lines──▶ python -I run.py (axora_engine)
                   │                                              └─ playwright.connect_over_cdp(http://127.0.0.1:<port>)
                   ├─ IxBrowserService ──HTTP 127.0.0.1:53200──▶ IX Browser Local API
                   └─ ProxyService (vault for passwords, TCP/TLS proxy tests)
```

### Protocol

- One JSON object per line, UTF-8, max 1 MiB per line.
- Request: `{"id": "<uuid>", "cmd": "<name>", "params": {…}}`.
- Response: `{"id": …, "ok": true, "result": {…}}` or
  `{"id": …, "ok": false, "error": {"code", "message", "retryable"}}`.
- Events (no id): `{"event": "log", "level", "message"}` — sanitised before logging.
- Progress events (Phase 8): `{"event": "progress", "id": <request id>, "stage": …}`, written and
  flushed before the step they announce (publishing relies on `submit` arriving before the click).
- Errors from commands with side effects carry `submitted: true|false`.
- The engine accepts only allowlisted commands (`engine.hello`, `engine.health`,
  `engine.shutdown`, `browser.check`, `browser.selfTest`, `x.publish`, `x.openPost`), validates
  every parameter, and only connects to loopback debugging endpoints. `x.publish` and `x.openPost`
  only open x.com post/compose pages (see [publishing.md](publishing.md)).
- Nothing listens on a port: the pipes belong to the parent process. On POSIX the engine also
  closes any socket it inherited from the parent before doing anything else.
- stdin is read from the raw descriptor on a helper thread; an oversized line is rejected
  once and the rest of it is discarded. The process exits when stdin closes (parent gone).

### Supervision (EngineService)

- Starts lazily when something needs the engine; one process at most.
- Handshake (`engine.hello`) within 20 s, health ping every 30 s, stop after 15 min idle.
- Every request has an id and a timeout; late replies are ignored.
- Unexpected exit → pending requests fail with `ENGINE_CRASHED`; the next request restarts
  it, at most 3 restarts in 5 minutes, then it stays failed until restarted manually.
- App quit → `engine.shutdown`, 2 s grace, then the process is killed.
- The child gets a minimal environment (no inherited secrets) and runs Python in isolated
  mode (`-I`), so user site-packages and `PYTHON*` variables are ignored.

## 4. Packaging

`npm run engine:prepare -- --platform=win|linux` downloads the pinned runtime, verifies its
SHA-256, extracts it to `engine-runtime/<platform>/python`, and installs the hash-locked
wheels from `engine/requirements.lock` into that runtime's `site-packages` (for Windows,
`pip --platform win_amd64` fetches Windows wheels on any host). electron-builder copies
`engine/` and `engine-runtime/<os>/` into the app's resources. Playwright's own browser
downloads are not used — the engine attaches to the browser IX Browser launched.
Debug symbols (`.pdb`), Tcl/Tk, IDLE, C headers and the runtime's own pip are removed after
the install (Windows runtime: 147 MB).

| Component | Version | Source |
| --- | --- | --- |
| CPython | 3.12.14 | python-build-standalone `20260924` (SHA-256 pinned) |
| playwright | 1.63.0 | PyPI (hash-locked) |
| greenlet, pyee, typing-extensions | see `engine/requirements.lock` | PyPI (hash-locked) |

## 5. Diagnostics

Settings → Automation shows the engine state in plain words with Restart and "Check it works"
(which really starts Playwright's driver). Since Phase 10 the UI shows no logs, paths or exit
codes; they are kept in the internal (redacted) log, which Settings → Security & app info can save
as a diagnostics file for support. Profiles have an
**automation compatibility check** that opens the profile through IX Browser, connects over
CDP, runs a controlled test page in the profile's own browser context, and reports each
step.

## 6. Known IX Browser limitations / unverified items

**Documented behaviour the app relies on** (IX Browser Local API SDK):

- `profile-open` returns `debugging_address` (the SDK's own example passes it to Selenium as
  `debuggerAddress`). The engine uses it with Playwright's `connect_over_cdp`.
- `profile-opened-list` does not document a debugging address. A profile opened outside
  X Auto (or before the app started) therefore has no known address: the compatibility
  check reports this as a blocker instead of guessing ports.
- `profile-update-proxy-for-custom-proxy` sets a custom proxy (`proxy_mode` 2). The docs do not
  say a running profile picks the change up, so the app only applies proxies to closed profiles
  and says so.

**Verification status (2026-10-10):**

| Item | Status | Evidence |
| --- | --- | --- |
| Engine protocol, allowlist, validation, crash/restart, shutdown | Verified | `npm run engine:test` (14 tests), e2e suite against the real app |
| Playwright `connect_over_cdp` + existing context + interact + disconnect | Verified against real Chrome | CDP integration tests; app-level compatibility check with the IX mock returning a real Chrome address |
| Attaching to a browser **launched by IX Browser** | **Not verified** | IX Browser is not installed on the development machine |
| Session (logins/cookies) preserved after attach | **Not verified with IX Browser** | Verified only that the existing context is used and its tabs are untouched in Chrome |
| Custom-proxy action accepted by IX Browser | **Not verified** | Payload checked against the SDK docs with a contract mock only |
| Proxy connectivity tests (HTTP/HTTPS CONNECT, SOCKS5, auth, TLS) | Verified | Real local proxies tunnelling to example.com:443 |
| Packaged app runs the bundled runtime (path with spaces) | Verified on Linux | `release/…/linux-unpacked`, engine started from `resources/` |
| Windows app build | Partly verified | `electron-builder --win` on Linux produced a complete `win-unpacked` app (PE32+ exe, Windows runtime inside `resources/engine-runtime`); it was not run |
| Windows NSIS installer | **Not built** | NSIS needs wine to create the uninstaller (`spawn wine ENOENT`); build on Windows or a host with wine |
| Install and run on a clean Windows machine | **Not verified** | No Windows machine available |

Until a real IX Browser compatibility check passes (Accounts → Browser profiles → a profile →
*Check automation compatibility*), browser automation must be treated as unverified.
