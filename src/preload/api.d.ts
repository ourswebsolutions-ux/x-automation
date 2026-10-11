import type { RelayApi } from '@shared/ipc/api'

declare global {
  interface Window {
    /** Typed bridge exposed by the preload script. */
    readonly relay: RelayApi
  }
}

export {}
