import { safeStorage } from 'electron'
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CredentialStatus } from '@shared/types/storage'
import type { ScopedLogger } from '../logging/logger'

export class CredentialUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CredentialUnavailableError'
  }
}

/**
 * Secure storage for API keys and tokens.
 *
 *  - Values are encrypted with Electron `safeStorage` (Windows DPAPI, macOS
 *    Keychain, or a Linux secret service) and written to a vault file that is
 *    separate from the SQLite database — so database backups never contain
 *    secrets, not even encrypted ones.
 *  - The database only stores a reference (vault key) and a short hint.
 *  - `get` is for main-process integrations only and is never exposed via IPC.
 */
export interface CredentialVault {
  status(): Omit<CredentialStatus, 'storedCount'>
  has(key: string): boolean
  set(key: string, secret: string): Promise<void>
  get(key: string): string | null
  delete(key: string): Promise<void>
  keys(): string[]
  clear(): Promise<number>
}

interface VaultFile {
  version: 1
  entries: Record<string, string>
}

const LINUX_BACKENDS: Record<string, string> = {
  gnome_libsecret: 'GNOME Keyring (libsecret)',
  kwallet: 'KWallet',
  kwallet5: 'KWallet 5',
  kwallet6: 'KWallet 6',
  basic_text: 'Fallback key (no OS keyring)',
  unknown: 'Unknown'
}

export class SafeStorageVault implements CredentialVault {
  private entries: Record<string, string> = {}
  private writeChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly log: ScopedLogger
  ) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<VaultFile>
      if (parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') this.entries = parsed.entries
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('Credential vault file could not be read; starting empty')
    }
  }

  status(): Omit<CredentialStatus, 'storedCount'> {
    const available = safeStorage.isEncryptionAvailable()
    if (process.platform === 'win32') {
      return {
        available,
        secure: available,
        backend: 'Windows DPAPI',
        detail: available ? 'Keys are encrypted for your Windows user account.' : 'Windows data protection is unavailable.'
      }
    }
    if (process.platform === 'darwin') {
      return {
        available,
        secure: available,
        backend: 'macOS Keychain',
        detail: available ? 'Keys are encrypted with a key held in your login Keychain.' : 'The Keychain is unavailable.'
      }
    }
    const backend = available ? safeStorage.getSelectedStorageBackend() : 'unknown'
    // basic_text encrypts with a hard-coded key: not real protection, so we refuse to store.
    const secure = available && backend !== 'basic_text' && backend !== 'unknown'
    return {
      available,
      secure,
      backend: LINUX_BACKENDS[backend] ?? backend,
      detail: secure
        ? 'Keys are encrypted with a key held in your desktop keyring.'
        : 'No desktop keyring was found. Install and unlock GNOME Keyring or KWallet to store API keys securely.'
    }
  }

  has(key: string): boolean {
    return key in this.entries
  }

  keys(): string[] {
    return Object.keys(this.entries)
  }

  async set(key: string, secret: string): Promise<void> {
    if (!this.status().secure) throw new CredentialUnavailableError('Secure credential storage is not available on this system.')
    this.entries[key] = safeStorage.encryptString(secret).toString('base64')
    await this.persist()
  }

  get(key: string): string | null {
    const encrypted = this.entries[key]
    if (!encrypted || !this.status().secure) return null
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch {
      this.log.warn(`Stored credential "${key}" could not be decrypted`)
      return null
    }
  }

  async delete(key: string): Promise<void> {
    if (!(key in this.entries)) return
    delete this.entries[key]
    await this.persist()
  }

  async clear(): Promise<number> {
    const count = Object.keys(this.entries).length
    this.entries = {}
    await this.persist()
    return count
  }

  private persist(): Promise<void> {
    const snapshot: VaultFile = { version: 1, entries: { ...this.entries } }
    const write = this.writeChain.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const temp = `${this.filePath}.tmp`
      await writeFile(temp, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 })
      await rename(temp, this.filePath)
    })
    // A failed write must not block later ones; the caller still sees the error.
    this.writeChain = write.catch(() => undefined)
    return write
  }
}
