import { app, BrowserWindow, dialog, nativeTheme, powerMonitor, protocol } from 'electron'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IpcEvent } from '@shared/ipc/channels'
import type { Preferences } from '@shared/types/preferences'
import { registerIpcHandlers, windowState } from './ipc/registerHandlers'
import { applySecurityHardening } from './security/hardening'
import { createServices, type AppServices } from './services/container'
import { backgroundForTheme, captureWindowState, createMainWindow, type SavedWindowState } from './window'

const WINDOW_STATE_KEY = 'window.state'
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000

let mainWindow: BrowserWindow | null = null
let services: AppServices | null = null

// The app was called "Axora Relay" before it became "X Auto". An existing installation keeps
// its data folder (database, images, vault) instead of starting empty under the new name.
// Electron may already have created the new folder, so the database file decides.
// Must run before anything touches userData (the single-instance lock does).
const LEGACY_USER_DATA = join(app.getPath('appData'), 'Axora Relay')
const databaseIn = (dir: string) => join(dir, 'data', 'relay.db')
if (!existsSync(databaseIn(app.getPath('userData'))) && existsSync(databaseIn(LEGACY_USER_DATA))) app.setPath('userData', LEGACY_USER_DATA)

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.enableSandbox()
  // Library images are shown through relay-asset://asset/<id>; the main process maps ids to files.
  protocol.registerSchemesAsPrivileged([{ scheme: 'relay-asset', privileges: { standard: true, secure: true } }])
  app.setAppUserModelId('com.axoraweb.relay')

  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // Before quitting: stop the queue (running tasks stop at a safe point or are
  // recovered on the next start), then stop the automation engine gracefully.
  let shutdownDone = false
  app.on('before-quit', (event) => {
    if (shutdownDone || !services) return
    const current = services
    current.scheduler.stop()
    current.automationSchedules.stop()
    current.updates.stop()
    const engineRunning = current.engine.status().state === 'ready' || current.engine.status().state === 'starting'
    if (!current.queue.isStarted && !engineRunning) {
      shutdownDone = true
      return
    }
    event.preventDefault()
    void current.queue
      .stop()
      .then(() => (engineRunning ? current.engine.stop('app quit') : undefined))
      .catch((error: unknown) => current.logger.scope('app').error('Shutdown step failed', error))
      .finally(() => {
        shutdownDone = true
        app.quit()
      })
  })

  // Graceful shutdown: checkpoint the WAL and close the database exactly once.
  app.on('will-quit', () => {
    services?.engine.killNow()
    services?.logger.scope('app').info('Shutting down')
    services?.logger.detachStore()
    services?.database.close()
    services = null
  })

  void app.whenReady().then(bootstrap).catch((error: unknown) => {
    dialog.showErrorBox('X Auto could not start', error instanceof Error ? error.message : String(error))
    app.exit(1)
  })
}

function applyLoginItem(preferences: Preferences): void {
  // Only meaningful for the installed app; in development it would register the Electron binary.
  if (!app.isPackaged || (process.platform !== 'win32' && process.platform !== 'darwin')) return
  app.setLoginItemSettings({ openAtLogin: preferences.startup.launchAtLogin })
}

function pruneHistory(current: AppServices): void {
  const days = current.preferences.get().retention.logDays
  const logs = current.logger.prune(days)
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()
  const activity = current.repositories.activity.pruneBefore(cutoff)
  const accountEvents = current.accounts.pruneEvents(cutoff)
  if (logs || activity || accountEvents) {
    current.logger.scope('retention').info(`Removed entries older than ${days} days`, { logs, activity, accountEvents })
  }
}

const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Serves library images to the renderer by asset id. The renderer never
 * supplies a path: ids are looked up in SQLite and resolved inside the asset
 * folder only. Files are sent with their sniffed type and nosniff.
 */
function registerAssetProtocol(current: AppServices): void {
  protocol.handle('relay-asset', async (request) => {
    const url = new URL(request.url)
    const id = url.pathname.replace(/^\//, '')
    if (url.hostname !== 'asset' || !ASSET_ID.test(id)) return new Response('Not found', { status: 404 })
    const file = current.assets.fileFor(id)
    if (!file) return new Response('Not found', { status: 404 })
    try {
      return new Response(await readFile(file.path), {
        headers: { 'content-type': file.mimeType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

async function bootstrap(): Promise<void> {
  const current = await createServices()
  services = current
  const log = current.logger.scope('app')
  log.info(`Starting ${app.getName()} ${app.getVersion()} on ${process.platform}`)

  applySecurityHardening(current.logger.scope('security'))
  registerAssetProtocol(current)
  registerIpcHandlers(current, () => mainWindow)

  const preferences = current.preferences.get()
  nativeTheme.themeSource = preferences.theme
  applyLoginItem(preferences)
  pruneHistory(current)
  setInterval(() => services && pruneHistory(services), PRUNE_INTERVAL_MS).unref()

  const send = (channel: string, payload?: unknown) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
  }

  current.preferences.subscribe((next, previous) => {
    nativeTheme.themeSource = next.theme
    mainWindow?.setBackgroundColor(backgroundForTheme())
    if (next.startup.launchAtLogin !== previous.startup.launchAtLogin) applyLoginItem(next)
    if (next.retention.logDays !== previous.retention.logDays) pruneHistory(current)
    send(IpcEvent.PreferencesChanged, next)
  })
  current.logger.subscribe((entry) => send(IpcEvent.LogAppended, entry))
  current.onIntegrationsChanged(() => send(IpcEvent.IntegrationsChanged))
  current.onSyncProgress((progress) => send(IpcEvent.IxSyncProgress, progress))
  current.onAccountsChanged(() => send(IpcEvent.AccountsChanged))
  let publishingTimer: NodeJS.Timeout | null = null
  current.onPublishingChanged(() => {
    if (publishingTimer) return
    publishingTimer = setTimeout(() => {
      publishingTimer = null
      send(IpcEvent.PublishingChanged)
    }, 150)
  })
  current.notifier.attach((notice) => send(IpcEvent.Notice, notice))
  current.onUpdatesChanged(() => send(IpcEvent.UpdatesChanged, current.updates.get()))
  current.onNoticeClick((notice) => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    if (notice.to) send(IpcEvent.Navigate, notice.to)
  })

  const openWindow = () => {
    const saved = preferences.startup.restoreWindow ? (current.repositories.settings.get<SavedWindowState>(WINDOW_STATE_KEY) ?? null) : null
    const window = createMainWindow(saved)
    mainWindow = window
    const pushState = () => send(IpcEvent.WindowState, windowState(window))
    for (const event of ['maximize', 'unmaximize', 'focus', 'blur', 'enter-full-screen', 'leave-full-screen'] as const) {
      window.on(event as 'maximize', pushState)
    }
    window.on('close', () => {
      if (services?.preferences.get().startup.restoreWindow) services.repositories.settings.set(WINDOW_STATE_KEY, captureWindowState(window))
    })
    window.on('closed', () => (mainWindow = null))
    window.webContents.on('render-process-gone', (_e, details) => log.error(`Renderer exited: ${details.reason}`))
  }

  openWindow()
  log.success('Main window ready')

  // Publishing: settle what the last shutdown left behind, then start working.
  current.scheduler.prepare()
  current.queue.start()
  current.scheduler.start()
  current.control.announceIfPaused()
  current.runs.recover()
  // Recurring schedules are no longer offered (campaigns run once, at their run time); their records
  // are kept, but they don't start runs any more.
  current.backup.startSchedule()
  current.updates.start()
  powerMonitor.on('resume', () => {
    services?.scheduler.tick()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow()
  })
}
