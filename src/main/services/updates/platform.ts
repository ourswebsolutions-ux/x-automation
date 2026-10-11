import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { UpdateMode } from '@shared/types/updates'
import type { UpdaterLike } from './updateService'

export interface UpdatePlatform {
  mode: UpdateMode
  reason: string | null
  /** The release feed baked into the app (resources/app-update.yml), for release-page links. */
  feed: { owner: string; repo: string } | null
}

interface Environment {
  isPackaged: boolean
  platform: NodeJS.Platform
  execPath: string
  resourcesPath: string
  productName: string
  env: NodeJS.ProcessEnv
  /** Returns codesign's description of the app bundle (macOS), or null. */
  codesignInfo?: (bundlePath: string) => string | null
}

/** Only a loopback http(s) feed is accepted for the development test hook. */
export function testFeedUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && ['127.0.0.1', 'localhost'].includes(url.hostname) ? url.toString() : null
  } catch {
    return null
  }
}

/** owner/repo from app-update.yml (written by electron-builder from the publish config). */
export function readFeed(resourcesPath: string): { owner: string; repo: string } | null {
  try {
    const text = readFileSync(join(resourcesPath, 'app-update.yml'), 'utf8')
    const field = (name: string) => new RegExp(`^${name}:\\s*['"]?([A-Za-z0-9_.-]+)['"]?\\s*$`, 'm').exec(text)?.[1] ?? null
    const owner = field('owner')
    const repo = field('repo')
    return field('provider') === 'github' && owner && repo ? { owner, repo } : null
  } catch {
    return null
  }
}

function defaultCodesign(bundlePath: string): string | null {
  const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=2', bundlePath], { encoding: 'utf8', timeout: 10_000 })
  return result.status === 0 ? `${result.stdout}${result.stderr}` : null
}

/**
 * How this particular copy can be updated. In-app installation is offered only where it can
 * work reliably and safely; everywhere else new versions are announced with a link to the
 * release page instead.
 */
export function detectUpdatePlatform(e: Environment): UpdatePlatform {
  if (!e.isPackaged) {
    return testFeedUrl(e.env.AXORA_TEST_UPDATE_FEED)
      ? { mode: 'in-app', reason: null, feed: null }
      : { mode: 'disabled', reason: 'Updates are turned off in development builds.', feed: null }
  }
  const feed = readFeed(e.resourcesPath)
  if (!feed) return { mode: 'disabled', reason: 'This build has no update feed configured.', feed: null }
  if (e.platform === 'win32') {
    // The NSIS installer leaves an uninstaller next to the app; a copy unpacked from the ZIP has none.
    const installed = existsSync(join(dirname(e.execPath), `Uninstall ${e.productName}.exe`))
    return installed
      ? { mode: 'in-app', reason: null, feed }
      : { mode: 'manual', reason: 'This copy was unpacked from the ZIP archive, so it can’t replace itself. Download the new version from the release page.', feed }
  }
  if (e.platform === 'darwin') {
    // macOS installs updates in place only for apps signed with a Developer ID certificate.
    const bundle = join(e.resourcesPath, '..', '..')
    const info = (e.codesignInfo ?? defaultCodesign)(bundle)
    return info && /Authority=Developer ID Application/.test(info)
      ? { mode: 'in-app', reason: null, feed }
      : { mode: 'manual', reason: 'This copy isn’t signed with an Apple Developer ID, so macOS won’t let it replace itself. Download the new version from the release page.', feed }
  }
  if (e.platform === 'linux') {
    if (e.env.APPIMAGE) return { mode: 'in-app', reason: null, feed }
    return { mode: 'manual', reason: 'Installed from the .deb package: download the new .deb from the release page and install it with your package manager.', feed }
  }
  return { mode: 'disabled', reason: 'Updates aren’t supported on this platform.', feed: null }
}

/** electron-updater's updater for this platform, configured for GitHub Releases (or the local test feed). */
export async function createUpdater(e: Environment, log: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void }): Promise<UpdaterLike> {
  const { autoUpdater } = (await import('electron-updater')).default
  autoUpdater.logger = { info: (m: unknown) => log.info(String(m)), warn: (m: unknown) => log.warn(String(m)), error: (m: unknown) => log.error(String(m)), debug: () => undefined }
  const testFeed = !e.isPackaged ? testFeedUrl(e.env.AXORA_TEST_UPDATE_FEED) : null
  if (testFeed) {
    // Development test hook only (never honoured by an installed app): a local generic feed.
    // electron-updater also reads an update config file when downloading in development; give it
    // one for the same local feed in a temp folder (an installed app uses its own app-update.yml).
    const configPath = join(mkdtempSync(join(tmpdir(), 'x-auto-dev-update-')), 'dev-app-update.yml')
    writeFileSync(configPath, `provider: generic\nurl: ${JSON.stringify(testFeed)}\nupdaterCacheDirName: x-auto-dev-updater\n`)
    autoUpdater.updateConfigPath = configPath
    autoUpdater.forceDevUpdateConfig = true
    autoUpdater.setFeedURL({ provider: 'generic', url: testFeed })
  }
  return autoUpdater as unknown as UpdaterLike
}
