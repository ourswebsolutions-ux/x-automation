import { app, session, shell } from 'electron'
import type { ScopedLogger } from '../services/logging/logger'
import { isSafeExternalUrl, isTrustedRendererUrl } from './trust'

/**
 * Global guards applied to every web contents:
 *  - no navigation away from the app
 *  - new windows denied (https links open in the system browser)
 *  - <webview> disabled
 *  - all permission requests (camera, notifications, etc.) denied
 */
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

  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    log.warn(`Denied permission request: ${permission}`)
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler(() => false)
}
