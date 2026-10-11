# Releasing X Auto

## The one command

```bash
npm run release -- 1.0.1
```

The next release only changes the number: `npm run release -- 1.0.2`.

| Option | Effect |
| --- | --- |
| `--dry-run` | Runs every check and test, sets the version, then restores the version files byte-for-byte. Nothing is committed, tagged, pushed or published. |
| `--e2e` | Also runs the end-to-end UI test (needs Google Chrome). |
| `--no-wait` | Stops after the push. CI still builds and publishes; run the same command again later to verify. |
| `--timeout=150` | Minutes to wait for CI (default 120). |

[scripts/release.mjs](../scripts/release.mjs) works through these stages:

1. **Version.** Must be `X.Y.Z` or `X.Y.Z-name.N`, compared with SemVer 2.0 precedence. A pre-release must
   start with a name (`beta`, `rc`, …), and that name becomes its update channel.
2. **Git.** You must be on `main`, with a clean tree. Only `main` is fetched, so local tags are never
   rewritten, and `main` must not be behind `origin/main`.
3. **GitHub, before anything changes.** Checks that:
   - `gh` is installed and logged in;
   - your account can write to the repository, and whether it is public;
   - Actions is enabled and the release workflow exists on GitHub.
4. **Existing tag and release.**
   - A new version must be higher than `package.json`.
   - If the tag already exists, the command resumes instead (see below).
5. **Tests.** Runs typecheck, the unit suites, the release tooling tests and the engine tests (plus E2E
   with `--e2e`). The bundled engine runtime must exist (`npm run engine:prepare`).
6. **Version bump.** Sets `package.json` and `package-lock.json` (both `version` fields) and checks that
   they match.
7. **Commit and tag.** Commits `Release vX.Y.Z` (only the two version files) and creates the annotated
   tag `vX.Y.Z`.
8. **Push.** `git push --atomic origin main vX.Y.Z`: both arrive, or neither does.
9. **Wait for CI.** Finds the run for exactly that tag and commit and follows each job. It reports a
   failed or cancelled run (failed jobs, failed steps, the last log lines), a run waiting more than
   30 minutes for a runner, and an overall timeout.
10. **Verify the published release.**
    - It is not a draft and has the correct pre-release flag.
    - All 11 files are uploaded, with the right sizes.
    - Every installer downloads, with the right file signature.
    - The update metadata matches the uploaded files.
    - The update feed can be read without credentials.
11. **Summary.** Prints the release URL, every download link, and the auto-update status. The command
    exits non-zero on any failure.

### Failures and re-runs

| What happened | What the command did | What to do |
| --- | --- | --- |
| A check or test failed | Restored the version files byte-for-byte; nothing was committed | Fix it, commit, run the command again |
| Ctrl+C during the tests or version bump | Restored the version files exactly | Run again |
| The push failed | Kept the commit and tag locally; nothing changed on GitHub | Fix access, then run the **same** command; it pushes the existing tag |
| A platform build failed | Nothing was published (the release is only published after all builds pass) | Temporary problem: `gh run rerun <id> --failed`, then run the same command. Code problem: fix, commit, release the next version |
| Interrupted while waiting | CI keeps going | Run the same command to keep waiting and verify |
| The release is incomplete | — | Run the same command; it rebuilds the existing tag and repairs the release (assets are replaced, not duplicated) |

**Existing tags are never moved or deleted.** If the tag exists, the command:

- **Already complete:** verifies the release and reports it.
- **Tag only local:** pushes it, after checking it is the release commit on `HEAD`.
- **Build still running:** waits for it.
- **Otherwise:** starts the workflow for that tag and repairs the release.

It refuses a tag whose `package.json` version doesn't match, and a tag made before this release
pipeline existed. That second case is **`v1.0.0`**.

## Current state of `v1.0.0` (2026-10-11)

`v1.0.0` is tagged at commit `01ef7a3 Release v1.0.0` and was pushed to GitHub. Its workflow run and
release could not be inspected from the development machine, because there was no GitHub login.

The tagged code predates this pipeline. It has:

- no auto-updater and no update metadata;
- the old installer names;
- no Windows ZIP and no macOS Intel build.

Rebuilding it now would either produce an incomplete release or put different code under the old tag.

**Recovery:** leave `v1.0.0` as it is (inspect its run and release on GitHub if you like), and make
**1.0.1** the first complete release:

```bash
gh auth login && gh auth setup-git    # once, on the machine you release from
npm run engine:prepare                # once, so the engine tests can run
git push origin main                  # the release pipeline must be on GitHub first
npm run release -- 1.0.1
```

## The workflow

The workflow is [.github/workflows/release.yml](../.github/workflows/release.yml) — one pipeline,
with no competing publisher.

| Job | Runner | Produces |
| --- | --- | --- |
| Build Linux x64 | `ubuntu-22.04` | `X-Auto-V-linux-x86_64.AppImage`, `X-Auto-V-linux-amd64.deb`, `latest-linux.yml` |
| Build Windows x64 | `windows-latest` | `X-Auto-V-windows-x64-setup.exe` (NSIS), `X-Auto-V-windows-x64.zip`, `latest.yml`, `.blockmap` |
| Build macOS arm64 | `macos-latest` (Apple silicon) | `X-Auto-V-macos-arm64.dmg`, `X-Auto-V-macos-arm64.zip`, its half of `latest-mac.yml`, `.blockmap`s |
| Build macOS x64 | `macos-15-intel` | `X-Auto-V-macos-x64.dmg`, `X-Auto-V-macos-x64.zip`, its half of `latest-mac.yml`, `.blockmap`s |
| Validate | `ubuntu-latest` | Merges the two mac metadata halves into one `latest-mac.yml`, then checks everything (see below) |
| Publish | `ubuntu-latest` (`contents: write`) | One GitHub Release: draft → upload → publish → verify |

**Every build job runs natively on its own OS:**

1. Installs dependencies.
2. Checks that the tag matches `package.json`.
3. Prepares the bundled engine runtime: the pinned, checksum-verified CPython 3.12 plus hash-locked
   Playwright wheels for that OS and architecture.
4. Runs typecheck, the unit tests and the engine tests (the release tooling tests run on Linux).
5. Packages the app. Each macOS architecture is built on its own runner, because the bundled Python
   runtime is architecture-specific.

**The Validate job checks:**

- All 11 files are present, and the installers are at least 10 MB.
- Each file has the right signature (MZ, ZIP, AppImage ELF, ar, UDIF `koly`), so a renamed archive
  can't pass as an installer.
- Every metadata file names the release version and references real files with matching size and
  SHA-512.
- It writes `SHA256SUMS.txt`, and puts the result in the Actions summary.

**The Publish job:**

- Runs only after **every** build and the validation succeed.
- Creates the release as a **draft**, uploads with `--clobber` (reruns replace files instead of
  duplicating them), and only then publishes.
- A **stable** release becomes the "latest" release. A **pre-release** is marked as one and never
  becomes "latest". Its metadata goes to `<name>.yml` files, so it can't enter the stable update
  channel.
- It then runs the same remote verification as the release command and writes the result to the
  Actions summary.

**Other triggers:**

- **Actions → Release → Run workflow** with an empty tag builds and validates without publishing.
  With a tag, it rebuilds and repairs that tag.
- A push to `main` that changes the build setup also runs build and validate only.

**Permissions:** read-only by default, and `contents: write` only for the Publish job, using the
built-in `GITHUB_TOKEN`. No other secret is needed for unsigned builds.

## Auto-updates

The app uses `electron-updater` 6.8.9 with **GitHub Releases** as the feed. The feed is baked into each
installed app as `resources/app-update.yml`.

**How updates behave:**

- **When it checks:** about 20 s after start-up, then every 6 hours, or when you click **Check for
  updates** in Settings → Security & app info → Updates.
- **What you see:** the panel shows the new version, its release notes (as plain text) and download
  progress.
- **Consent:** nothing is downloaded or installed without your go-ahead. The app never installs
  silently on quit.
- **Installing:** **Restart and install** is refused while a post is being published or a run is
  preparing posts. Before restarting, the app stops scheduling, the queue and the engine gracefully.
  Scheduled posts stay in the database and continue after the restart.
- **Your data is never touched:** updates replace program files only. The database, settings,
  accounts, proxies, drafts, schedules and images live in the user-data folder, and the NSIS
  installer keeps it on update and uninstall.
- **Channels:** a stable build never accepts a pre-release (`allowPrerelease` is off, and offers are
  re-validated as newer stable versions). A pre-release build follows its pre-release channel.
- **Trust:** only the configured GitHub feed is used, and downloads are verified against the SHA-512
  in the release metadata. Development builds don't check for updates at all. The only exception is a
  loopback test feed, used by `tests/e2e/updates.e2e.mjs`, which installed apps ignore.
- **Errors:** being offline, a missing release or missing metadata gives a plain status with no
  repeated notices. Each distinct failure is announced once per version.

| Installed as | Update behaviour |
| --- | --- |
| Windows, NSIS installer | **In-app.** Download, verify, then restart to install. Works unsigned; SmartScreen may warn when the installer runs. |
| Windows, ZIP | **Manual.** New versions are announced, and the release page opens (a ZIP copy can't replace itself). |
| macOS, signed with a Developer ID | **In-app**, through Squirrel.Mac using the arch-specific `.zip` from `latest-mac.yml`. |
| macOS, unsigned or ad-hoc signed (the default) | **Manual.** macOS refuses in-place updates of unsigned apps, so the release page opens. |
| Linux AppImage | **In-app.** The new AppImage replaces the old file on restart. |
| Linux `.deb` | **Manual.** New versions are announced, and the release page opens to download the new `.deb`. There is no privileged in-app install. |

**The feed must be publicly readable.** Installed apps read `latest*.yml` without credentials, so
while the repository is **private**, the releases are published but **no installed app can discover
updates**. The release command and the workflow both report this. To enable updates, do one of the
following:

- make this repository public; or
- publish releases to a separate public repository. Set `publish.owner`/`publish.repo` in
  `electron-builder.yml`, and give the workflow a token for that repository. This isn't configured
  yet.

A private feed would need a token inside every installed app, which isn't safe.

## Signing (optional)

Unsigned installers work, but:

- Windows SmartScreen shows "unknown publisher".
- On macOS, users right-click **Open** the first time, and in-app updates are off (see above).

To sign, add repository secrets (**Settings → Secrets and variables → Actions**). They are passed to
electron-builder only when present, and nothing is hardcoded.

| Secret | Purpose |
| --- | --- |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | Windows code-signing certificate (.pfx, base64 or https URL) and its password |
| `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` | "Developer ID Application" certificate (.p12, base64) and its password |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Notarization |

**Notarization needs more work.** It requires the hardened runtime (`mac.hardenedRuntime: true`),
entitlements that let the bundled Python interpreter and Playwright driver run, and signing of the
binaries in `Contents/Resources/engine-runtime`. Test it on a Mac with a real certificate before
turning it on.

## Verifying a release and future updates

- **Release page:** the command prints the URL and each link. In the browser, check that the release
  is published (not a draft) with 11 files plus `SHA256SUMS.txt` and the `.blockmap` files.
- **Feed** (only works once the releases are public):
  `curl -L https://github.com/ourswebsolutions-ux/x-automation/releases/latest/download/latest.yml`
- **Client update:** install version N, publish N+1 with the release command, then open Settings →
  Security & app info → Updates → **Check for updates**.
  - On Windows (NSIS) or a Linux AppImage, download, then **Restart and install**, and confirm the
    version and your data afterwards.
  - On a `.deb`, an unsigned Mac or the ZIP, the release page opens.

## Tests

| Command | What it checks |
| --- | --- |
| `npm test` | Unit suites, release tooling tests, engine tests |
| `npm run test:release` | Version rules, required asset list, installer signatures, metadata merge and validation, and the release command's dry run and refusals in a scratch repository |
| `npm run test:updates` | Update lifecycle against a local feed, using the real electron-updater and the real UI |
| `npm run test:e2e` | The automation end-to-end test |
