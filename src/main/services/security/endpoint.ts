import { ACTIVATION_PUBLIC_KEY } from '@shared/config/activation'

/** Set at build time from XAUTO_ACTIVATION_URL (see electron.vite.config.ts). */
declare const __ACTIVATION_URL__: string | undefined

const LOCAL_SERVER = 'http://127.0.0.1:8787'

/** Installed builds only ever use the address built into them, and only over https. */
export function activationEndpoint(isPackaged: boolean, env: NodeJS.ProcessEnv): string | null {
  const built = typeof __ACTIVATION_URL__ === 'string' ? __ACTIVATION_URL__.trim().replace(/\/+$/, '') : ''
  if (isPackaged) return built.startsWith('https://') ? built : null
  // Development: `none` behaves like an installed build without a server (activation codes only).
  if (env['XAUTO_ACTIVATION_URL']?.trim() === 'none') return null
  return env['XAUTO_ACTIVATION_URL']?.trim().replace(/\/+$/, '') || built || LOCAL_SERVER
}

export function activationPublicKey(isPackaged: boolean, env: NodeJS.ProcessEnv): string {
  return (!isPackaged && env['XAUTO_ACTIVATION_PUBLIC_KEY']?.trim()) || ACTIVATION_PUBLIC_KEY
}
