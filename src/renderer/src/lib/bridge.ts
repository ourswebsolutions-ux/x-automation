import type { RelayApi } from '@shared/ipc/api'

/** True when the preload bridge is present (always, inside Electron). */
export const hasBridge = typeof window !== 'undefined' && 'relay' in window

/** The typed preload API. Components never touch ipcRenderer directly. */
export const relay: RelayApi = hasBridge ? window.relay : (undefined as unknown as RelayApi)

/** Strips the "[CODE] " prefix the preload adds to IPC errors. */
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': /, '').replace(/^\[[A-Z_]+\]\s*/, '')
}
