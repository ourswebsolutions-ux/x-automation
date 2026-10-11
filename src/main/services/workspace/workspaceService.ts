import type { WorkspaceSummary } from '@shared/types/domain'
import type { WorkspaceRepositories } from '../database/repositories'
import type { ProfileRepository } from '../database/sqlite/profileRepository'
import type { ScheduleRepository } from '../database/sqlite/scheduleRepository'
import type { QueueService } from '../queue/queueService'

/** Read model behind the dashboard. Reads real repositories only. */
export class WorkspaceService {
  constructor(
    private readonly repositories: WorkspaceRepositories,
    private readonly profiles: ProfileRepository,
    private readonly queue: QueueService,
    private readonly schedules: ScheduleRepository
  ) {}

  async getSummary(): Promise<WorkspaceSummary> {
    const { drafts, activity } = this.repositories
    const [allDrafts, recentActivity] = await Promise.all([drafts.list(), activity.recent(8)])
    const counts = this.queue.counts()
    return {
      // Browser profiles synced from IX Browser and currently available.
      profiles: this.profiles.counts().available,
      drafts: allDrafts.filter((draft) => draft.status === 'draft' || draft.status === 'ready').length,
      scheduled: this.schedules.counts().upcoming,
      pendingTasks: counts.queued + counts.running,
      recentActivity,
      recentTasks: this.queue.recent(6)
    }
  }
}
