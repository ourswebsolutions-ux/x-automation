import { execFile } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { ScopedLogger } from '../logging/logger'

const run = promisify(execFile)

/** No I, O, 0 or 1, so an ID survives being read out over the phone. Matches the server's check. */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const ID_CHARS = 12

export interface DeviceIdentity {
  /** XA-XXXX-XXXX-XXXX. Shown to the customer and shared with the administrator. */
  activationId: string
  /** Never displayed: proves to the server that a request comes from this device. */
  deviceKey: string
}

/** Same machine, same identity, so reinstalling X Auto doesn't look like a new device. */
export function deriveIdentity(machineId: string): DeviceIdentity {
  const digest = createHmac('sha256', 'x-auto/activation-id/v1').update(machineId).digest()
  let bits = 0
  let buffered = 0
  let id = ''
  for (const byte of digest) {
    buffered = (buffered << 8) | byte
    bits += 8
    while (bits >= 5 && id.length < ID_CHARS) {
      bits -= 5
      id += ALPHABET[(buffered >> bits) & 31]
    }
    buffered &= (1 << bits) - 1
  }
  return {
    activationId: `XA-${id.slice(0, 4)}-${id.slice(4, 8)}-${id.slice(8, 12)}`,
    deviceKey: createHmac('sha256', 'x-auto/device-key/v1').update(machineId).digest('hex')
  }
}

async function osMachineId(platform: NodeJS.Platform): Promise<string | null> {
  try {
    if (platform === 'win32') {
      const reg = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'reg.exe')
      const { stdout } = await run(reg, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { windowsHide: true })
      return /MachineGuid\s+REG_\w+\s+([0-9a-fA-F-]{16,})/.exec(stdout)?.[1]?.toLowerCase() ?? null
    }
    if (platform === 'darwin') {
      const { stdout } = await run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])
      return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout)?.[1] ?? null
    }
    for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      const id = (await readFile(path, 'utf8').catch(() => '')).trim()
      if (id) return id
    }
  } catch {
    // Falls through to the stored identifier.
  }
  return null
}

/** Keeps a generated identifier when the operating system offers none. */
async function storedMachineId(file: string): Promise<string> {
  const existing = (await readFile(file, 'utf8').catch(() => '')).trim()
  if (existing) return existing
  const created = randomBytes(32).toString('hex')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, created, { encoding: 'utf8', mode: 0o600 })
  return created
}

export async function loadDeviceIdentity(platform: NodeJS.Platform, fallbackFile: string, log: ScopedLogger): Promise<DeviceIdentity> {
  const machineId = await osMachineId(platform)
  if (machineId) return deriveIdentity(machineId)
  log.warn('No machine identifier available; using a stored one')
  return deriveIdentity(await storedMachineId(fallbackFile))
}
