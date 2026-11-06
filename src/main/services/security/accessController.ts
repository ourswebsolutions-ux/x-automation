import { channelAccess } from '@shared/ipc/access'
import type { IpcChannelName } from '@shared/ipc/channels'
import type { ScopedLogger } from '../logging/logger'

export class AccessDeniedError extends Error {
  constructor(
    readonly code: 'LOCKED' | 'SUBSCRIPTION_REQUIRED',
    message: string
  ) {
    super(message)
    this.name = 'AccessDeniedError'
  }
}

interface Deps {
  pin: { readonly isUnlocked: boolean }
  subscription: { readonly isActive: boolean }
  /** Starts scheduled publishing and the queue. */
  startAutomation: () => void
  /** Stops them; waits for a running task to reach a safe point. */
  stopAutomation: () => Promise<void>
  log: ScopedLogger
}

/**
 * Where the two independent layers meet. Each is checked on its own, so the PIN never depends on
 * the subscription or the reverse. Both must pass for IPC calls marked premium and for background
 * automation, which runs without any IPC call and so can't rely on the router alone.
 */
export class AccessController {
  private running = false
  private changing: Promise<void> = Promise.resolve()

  constructor(private readonly deps: Deps) {}

  get automationAllowed(): boolean {
    return this.deps.pin.isUnlocked && this.deps.subscription.isActive
  }

  /** Whether scheduled publishing is on right now. */
  get automationRunning(): boolean {
    return this.running
  }

  /** Throws unless this channel may be used now. Runs before a handler sees its payload. */
  guard(channel: IpcChannelName): void {
    const level = channelAccess(channel)
    if (level === 'open') return
    if (!this.deps.pin.isUnlocked) throw new AccessDeniedError('LOCKED', 'Enter your PIN to continue.')
    if (level === 'premium' && !this.deps.subscription.isActive) {
      throw new AccessDeniedError('SUBSCRIPTION_REQUIRED', 'This needs an active subscription. Activate X Auto in Settings → Subscription.')
    }
  }

  /** Brings automation in line with the current state. Safe to call on any change. */
  sync(): Promise<void> {
    this.changing = this.changing.then(async () => {
      const allowed = this.automationAllowed
      if (allowed === this.running) return
      try {
        if (allowed) this.deps.startAutomation()
        else await this.deps.stopAutomation()
        this.running = allowed
        this.deps.log.info(allowed ? 'Automation started' : 'Automation stopped: subscription or PIN required')
      } catch (error) {
        this.deps.log.error('Automation could not be switched', error)
      }
    })
    return this.changing
  }
}
