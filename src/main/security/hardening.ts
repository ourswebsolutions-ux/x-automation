import { app, session, shell, type WebContents } from 'electron'
import type { ScopedLogger } from '../services/logging/logger'
import { isSafeExternalUrl, isTrustedRendererUrl } from './trust'

/**
 * Global guards applied to every web contents:
 *  - no navigation away from the app
 *  - new windows denied (https links open in the system browser)
 *  - <webview> disabled
 *  - all permission requests (camera, notifications, etc.) denied, except
 *    our own renderer writing to the clipboard (the app's Copy buttons)
 */
const CLIPBOARD_WRITE = 'clipboard-sanitized-write'

function isOwnClipboardWrite(contents: WebContents | null, permission: string): boolean {
  return permission === CLIPBOARD_WRITE && contents !== null && isTrustedRendererUrl(contents.getURL())
}

export function applySecurityHardening(log: ScopedLogger): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => {
      if (!isTrustedRendererUrl(url)) {
        event.preventDefault()
        log.warn(`Blocked navigation to ${url}`)
      }
    })

    contents.on('will-attach-webview', (event) => {
      event.preventDefault()
      log.warn('Blocked <webview> attachment')
    })

    contents.setWindowOpenHandler(({ url }) => {
      if (isSafeExternalUrl(url)) void shell.openExternal(url)
      else log.warn(`Blocked window.open for ${url}`)
      return { action: 'deny' }
    })
  })

  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    const allowed = isOwnClipboardWrite(contents, permission)
    if (!allowed) log.warn(`Denied permission request: ${permission}`)
    callback(allowed)
  })
  session.defaultSession.setPermissionCheckHandler((contents, permission) => isOwnClipboardWrite(contents, permission))
}
