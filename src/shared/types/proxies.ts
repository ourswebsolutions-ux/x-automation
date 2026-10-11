import type { Id, Timestamp } from './domain'

/** Proxy types IX Browser's custom-proxy mode documents (besides "direct" and "ssh", which aren't offered). */
export type ProxyScheme = 'http' | 'https' | 'socks5'

export interface ProxyTest {
  ok: boolean
  testedAt: Timestamp
  /** Time to complete the tunnel (and TLS handshake) through the proxy. */
  latencyMs: number | null
  /** Plain-language reason when it failed; never contains the password. */
  error: string | null
  /** What was verified: "tunnel" (CONNECT/SOCKS accepted) or "tls" (TLS handshake through it). */
  verified: 'tunnel' | 'tls' | null
  target: string
}

export interface Proxy {
  id: Id
  label: string
  scheme: ProxyScheme
  host: string
  port: number
  username: string | null
  /** A password is stored (encrypted, in the OS-protected vault). Never returned. */
  hasPassword: boolean
  /** The stored password can no longer be decrypted on this device. */
  passwordMissing: boolean
  enabled: boolean
  notes: string
  lastTest: ProxyTest | null
  /** Profiles this proxy is assigned to. */
  assignedProfiles: number
  isDefault: boolean
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface ProxyInput {
  label: string
  scheme: ProxyScheme
  host: string
  port: number
  username: string | null
  /** undefined = keep the stored password; null = remove it; string = replace it. */
  password?: string | null
  enabled: boolean
  notes: string
}

export type AssignmentStatus = 'applied' | 'failed'

/** A proxy assigned to an IX Browser profile, and whether IX Browser accepted it. */
export interface ProxyAssignment {
  profileId: Id
  externalId: number
  profileName: string
  proxyId: Id
  proxyLabel: string
  status: AssignmentStatus
  appliedAt: Timestamp | null
  error: string | null
  updatedAt: Timestamp
}

export interface ProxyImportResult {
  added: number
  duplicates: number
  rejected: { line: number; reason: string }[]
  cancelled: boolean
}

export interface ProxyExportResult {
  cancelled: boolean
  fileName?: string
  count?: number
}
