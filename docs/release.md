# Releasing X Auto

## One command

```bash
npm run release -- 1.0.0            # checks, tests, commit, tag v1.0.0, push → GitHub builds and publishes
npm run release -- 1.0.0 --dry-run  # every check and test, then undo; nothing committed or pushed
npm run release -- 1.0.0 --e2e      # also runs the end-to-end test (needs Google Chrome)
```

[scripts/release.mjs](../scripts/release.mjs) runs these steps:

1. **Version checks.** The version must be `X.Y.Z` or `X.Y.Z-pre` and newer than `package.json`. Tag
   `vX.Y.Z` must not exist locally or on `origin`.
2. **Repository checks.** You must be on `main`, with a clean working tree, and not behind
   `origin/main`.
3. **Version bump.** Sets the version in `package.json` and `package-lock.json`.
4. **Tests.** Runs typecheck, the unit suites and the engine tests (and E2E with `--e2e`). Run
   `npm run engine:prepare` once beforehand so the engine tests have their runtime.
5. **Commit and tag.** Commits `Release vX.Y.Z` and creates the annotated tag `vX.Y.Z`.
6. **Push.** Pushes `main` and the tag together with `git push --atomic`. The tag push starts the
   workflow.

If any step fails, the version change is undone and nothing is committed, tagged or pushed.

## The workflow

The workflow is [.github/workflows/release.yml](../.github/workflows/release.yml).

| Job | Runner | Output |
| --- | --- | --- |
| Build (Linux x64) | `ubuntu-22.04` | `X-Auto-<v>-linux-x86_64.AppImage`, `X-Auto-<v>-linux-amd64.deb` |
| Build (Windows x64) | `windows-latest` | `X-Auto-Setup-<v>-x64.exe` (NSIS) |
| Build (macOS arm64) | `macos-latest` (Apple silicon) | `X-Auto-<v>-mac-arm64.dmg`, `X-Auto-<v>-mac-arm64.zip` |
| Publish GitHub Release | `ubuntu-latest` | Release `vX.Y.Z` with all files above plus `SHA256SUMS.txt` |

**Each build job does the following, natively on its own OS:**

1. `npm ci`.
2. Checks that the tag matches `package.json`.
3. Prepares the bundled engine runtime: the pinned, checksum-verified CPython 3.12 plus hash-locked
   Playwright wheels for that OS and architecture.
4. Runs typecheck, the unit tests and the engine tests.
5. Builds and packages the app, then uploads the installers as workflow artifacts.

**Safeguards:**

- The release job runs only after **all three** builds succeed (`fail-fast`, `needs: build`), so a
  failed platform never produces a partial release.
- **Reruns are safe.** An existing release is updated, not duplicated. Assets are uploaded with
  `--clobber`, which replaces files of the same name. A new release is created as a draft and
  published only after every file is uploaded.
- **Release notes** list the commits since the previous `v*` tag and a table of each file's platform,
  architecture, type and size ([scripts/release-notes.mjs](../scripts/release-notes.mjs)).

**Other triggers:**

- **Actions → Release → Run workflow** with an empty tag builds all three platforms with no release.
  With an existing tag, it re-releases that tag.
- A push to `main` that changes the build setup also runs build-only, to catch packaging problems
  early.

**Not tested in CI:** the end-to-end UI test isn't run there, because it needs a desktop session and
Chrome. Run it locally with `npm run test:e2e`.

## Repository settings

- **Settings → Actions → General → Actions permissions:** allow actions. The workflow uses
  `actions/checkout`, `setup-node`, `setup-python`, `upload-artifact` and `download-artifact`.
- **Workflow permissions:** the default *Read repository contents* is enough. Only the release job
  asks for `contents: write`, through the `permissions:` key, using the built-in `GITHUB_TOKEN`. If
  an organization policy forbids raising token permissions, allow it for this repository.
- No secrets are needed for unsigned builds.

## Signing (optional, off by default)

Unsigned installers work. Windows SmartScreen shows "unknown publisher", and on macOS users
right-click the app and choose **Open** the first time. To sign, add these repository secrets
(**Settings → Secrets and variables → Actions**). The workflow passes them to electron-builder
only when they exist, and nothing is hardcoded.

| Secret | Used for |
| --- | --- |
| `WIN_CSC_LINK` | Windows code-signing certificate (.pfx), base64-encoded or an https URL |
| `WIN_CSC_KEY_PASSWORD` | Its password |
| `MAC_CSC_LINK` | "Developer ID Application" certificate (.p12), base64-encoded |
| `MAC_CSC_KEY_PASSWORD` | Its password |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Notarization with Apple |

**Extra work for macOS notarization:**

- Apple requires the hardened runtime. Set `mac.hardenedRuntime: true` in `electron-builder.yml`.
- Add entitlements that allow the bundled Python interpreter and the Playwright driver to run.
- Sign the binaries inside `Contents/Resources/engine-runtime` too.
- This needs testing on a Mac with a real certificate before it is turned on.

Without these secrets, macOS builds stay unsigned and are not notarized.

## Logo and name

- **One logo for every platform.** `build/icon.svg` is the same mark as the in-app `BrandMark`.
  `build/icon.png` is that SVG rendered at 1024×1024, and electron-builder derives the macOS `.icns`
  and the Linux icon from it. `build/icon.ico` (16–256 px) is used for the Windows app and the NSIS
  installer and uninstaller.
- **Product name:** X Auto. An installation from before the rename ("Axora Relay") keeps using its
  existing data folder, and backups made before the rename can still be restored.

## Verification status

- **Linux:** AppImage and .deb are built and launch-tested locally. The engine starts from inside the
  package.
- **Windows and macOS:** built only on GitHub's native runners. Check a workflow run before relying
  on them. Neither installer has been tested on a clean machine.
- **Real-world checks:** x.com publishing and a real IX Browser installation are still unverified.
