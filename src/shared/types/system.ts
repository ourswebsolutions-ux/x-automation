import type { ActivityLevel, Timestamp } from './domain'

export interface AppInfo {
  name: string
  version: string
  phase: number
  platform: string
  arch: string
  versions: { electron: string; chrome: string; node: string }
  isPackaged: boolean
  /** Launch-at-login is only applied for the installed app on Windows and macOS. */
  loginItemSupported: boolean
}

export interface SecurityPosture {
  contextIsolation: boolean
  sandbox: boolean
  nodeIntegration: boolean
  webSecurity: boolean
  credentialEncryptionAvailable: boolean
}

export interface WindowState {
  isMaximized: boolean
  isFocused: boolean
}

export type LogLevel = ActivityLevel | 'debug'

/** Optional structured context. Sensitive keys are redacted before storage. */
export type LogMeta = Record<string, string | number | boolean | null>

export interface LogEntry {
  id: number
  at: Timestamp
  level: LogLevel
  scope: string
  message: string
  meta: LogMeta | null
}

export interface LogQuery {
  levels?: LogLevel[]
  search?: string
  limit?: number
}
