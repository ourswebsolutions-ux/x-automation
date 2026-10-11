import type { Id } from '@shared/types/domain'
import type { AutomationSnapshot } from '@shared/types/publishing'
import type { AccountRepository } from '../database/sqlite/accountRepository'
import type { QueueRepository } from '../database/sqlite/queueRepository'
import type { ScheduleRepository } from '../database/sqlite/scheduleRepository'
import type { EngineService } from '../engine/engineService'
import type { ScopedLogger } from '../logging/logger'
import type { Notifier } from '../notifications/notifier'
import type { Scheduler } from '../publishing/scheduler'
import type { QueueService } from '../queue/queueService'

interface Deps {
  queue: QueueService
  queueRepo: QueueRepository
  schedules: ScheduleRepository
  accounts: AccountRepository
  engine: EngineService
  scheduler: Scheduler
  notifier: Notifier
  log: ScopedLogger
}

/**
 * The automation control centre: one view of what is running, and the
 * pause / resume / stop controls. Also tells the user (once) when the engine
 * cannot recover, instead of letting automation look like it is running.
 */
export class AutomationControlService {
  constructor(private readonly deps: Deps) {
    deps.engine.onState((state, previous) => {
      if (state === 'failed') {
        deps.notifier.notify(
          { tone: 'danger', event: 'taskFailures', title: 'Automation stopped', body: 'The automation engine stopped repeatedly and could not recover. Restart it in Settings → Automation.', to: '/settings?section=automation' },
          { key: 'engine-failed' }
        )
      } else if (state === 'ready' && (previous === 'failed' || previous === 'crashed')) {
        deps.notifier.clear('engine-failed')
      }
    })
  }

  snapshot(): AutomationSnapshot {
    const { queue } = this.deps
    const counts = queue.counts()
    const running = queue.current()
    let current: AutomationSnapshot['current'] = null
    if (running) {
      const view = this.deps.queueRepo.view(running.id)
      const account = running.accountId ? this.deps.accounts.get(running.accountId) : null
      if (view) current = { ...view, profileName: account?.profile?.name ?? null }
    }
    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    return {
      state: queue.paused ? 'paused' : current ? 'running' : 'idle',
      pausedAt: queue.pausedSince,
      current,
      counts,
      today: queue.finishedBetween(start.toISOString(), end.toISOString()),
      next: this.deps.schedules.nextPending(),
      engine: this.deps.engine.status().state
    }
  }

  pause(): AutomationSnapshot {
    this.deps.queue.pause()
    return this.snapshot()
  }

  /** Resumes; posts whose time passed long ago while paused are not sent late — they wait for the user. */
  resume(): AutomationSnapshot {
    this.deps.scheduler.prepare()
    this.deps.queue.resume()
    return this.snapshot()
  }

  /** Pauses and stops the running task at its next safe point (it goes back in the queue). */
  stopNow(): AutomationSnapshot {
    const stopping = this.deps.queue.stopNow()
    this.deps.log.info('Automation stopped by the user', { running: stopping })
    return this.snapshot()
  }

  hold(id: Id): void {
    this.deps.queue.setHeld(id, true)
  }

  release(id: Id): void {
    this.deps.queue.setHeld(id, false)
  }

  /** At start-up: remind the user that automation was left paused. */
  announceIfPaused(): void {
    if (!this.deps.queue.paused) return
    this.deps.notifier.notify({ tone: 'info', event: 'systemNotices', title: 'Automation is paused', body: 'Scheduled posts wait in the queue until you resume.', to: '/queue' })
  }
}
