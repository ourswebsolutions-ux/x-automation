import { app } from 'electron'

/** True when a URL belongs to our own renderer (dev server or packaged file). */
export function isTrustedRendererUrl(rawUrl: string): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }

  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devServer) {
    return url.origin === new URL(devServer).origin
  }

  return url.protocol === 'file:' && decodeURIComponent(url.pathname).endsWith('/renderer/index.html')
}

export function isSafeExternalUrl(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).protocol === 'https:'
  } catch {
    return false
  }
}
