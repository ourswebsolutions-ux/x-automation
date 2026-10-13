import { BrowserWindow, nativeTheme, screen, type Rectangle } from 'electron'
import { join } from 'node:path'

export const WINDOW_BACKGROUND = { dark: '#0c0d0f', light: '#f4f3ef' } as const

export function backgroundForTheme(): string {
  return nativeTheme.shouldUseDarkColors ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light
}

/** Single source of truth for renderer isolation, also reported in Settings. */
export const SECURE_WEB_PREFERENCES = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false
} as const

export interface SavedWindowState {
  bounds: Rectangle
  maximized: boolean
}

const MIN = { width: 960, height: 640 }

/** Restores saved bounds only if they are still visible on a connected display. */
function usableBounds(saved: SavedWindowState | null): Rectangle | null {
  if (!saved) return null
  const { bounds } = saved
  if (bounds.width < MIN.width || bounds.height < MIN.height) return null
  const visible = screen.getAllDisplays().some(({ workArea: a }) => {
    const overlapX = Math.min(a.x + a.width, bounds.x + bounds.width) - Math.max(a.x, bounds.x)
    const overlapY = Math.min(a.y + a.height, bounds.y + bounds.height) - Math.max(a.y, bounds.y)
    return overlapX >= 120 && overlapY >= 80
  })
  return visible ? bounds : null
}

export function createMainWindow(saved: SavedWindowState | null): BrowserWindow {
  const { workAreaSize } = screen.getPrimaryDisplay()
  const isMac = process.platform === 'darwin'
  const bounds = usableBounds(saved)

  const window = new BrowserWindow({
    ...(bounds ?? { width: Math.min(1440, workAreaSize.width), height: Math.min(920, workAreaSize.height) }),
    minWidth: MIN.width,
    minHeight: MIN.height,
    show: false,
    // Custom title bar: frameless on Windows/Linux, inset traffic lights on macOS.
    frame: isMac,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    backgroundColor: backgroundForTheme(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      ...SECURE_WEB_PREFERENCES,
      spellcheck: true
    }
  })

  window.once('ready-to-show', () => {
    if (bounds && saved?.maximized) window.maximize()
    window.show()
  })

  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) {
    void window.loadURL(devServer)
    // Development only (npm run dev): DevTools opens with the app; F12 or Ctrl+Shift+I toggles it.
    // Packaged builds never load the dev server, so this never applies to installed copies.
    window.webContents.once('did-finish-load', () => window.webContents.openDevTools({ mode: 'detach' }))
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      if (input.key === 'F12' || ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i')) {
        event.preventDefault()
        window.webContents.toggleDevTools()
      }
    })
  } else void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))

  return window
}

export function captureWindowState(window: BrowserWindow): SavedWindowState {
  return { bounds: window.getNormalBounds(), maximized: window.isMaximized() }
}
