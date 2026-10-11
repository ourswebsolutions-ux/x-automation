import type { ActivityLevel, ScheduleStatus, TaskKind, TaskStatus } from '@shared/types/domain'
import type { IntegrationState } from '@shared/types/integrations'
import type { LogEntry } from '@shared/types/system'
import type { Tone } from '@/components/ui'

interface StatusMeta {
  tone: Tone
  label: string
  pulse?: boolean
}

export const TASK_STATUS: Record<TaskStatus, StatusMeta> = {
  queued: { tone: 'neutral', label: 'Queued' },
  running: { tone: 'info', label: 'Running', pulse: true },
  succeeded: { tone: 'success', label: 'Succeeded' },
  failed: { tone: 'danger', label: 'Failed' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
  'needs-review': { tone: 'warning', label: 'Needs review' }
}

export const SCHEDULE_STATUS: Record<ScheduleStatus, StatusMeta> = {
  pending: { tone: 'info', label: 'Scheduled' },
  queued: { tone: 'info', label: 'Publishing', pulse: true },
  completed: { tone: 'success', label: 'Published' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
  failed: { tone: 'danger', label: 'Failed' },
  missed: { tone: 'warning', label: 'Missed' },
  'needs-review': { tone: 'warning', label: 'Needs review' }
}

export const TASK_KIND: Record<TaskKind, string> = {
  publish: 'Publish post',
  reply: 'Reply',
  'generate-text': 'Generate text',
  'generate-image': 'Generate image',
  'sync-profiles': 'Sync profiles'
}

export const INTEGRATION_STATE: Record<IntegrationState, StatusMeta> = {
  planned: { tone: 'neutral', label: 'Planned' },
  'not-configured': { tone: 'warning', label: 'Not configured' },
  configured: { tone: 'info', label: 'Configured' },
  connected: { tone: 'success', label: 'Connected' },
  degraded: { tone: 'warning', label: 'Limited' },
  error: { tone: 'danger', label: 'Unavailable' },
  available: { tone: 'success', label: 'Available' }
}

export const ACTIVITY_TONE: Record<ActivityLevel, Tone> = {
  info: 'neutral',
  success: 'success',
  warning: 'warning',
  error: 'danger'
}

export const LOG_LEVEL: Record<LogEntry['level'], StatusMeta> = {
  debug: { tone: 'neutral', label: 'Debug' },
  info: { tone: 'neutral', label: 'Info' },
  success: { tone: 'success', label: 'OK' },
  warning: { tone: 'warning', label: 'Warn' },
  error: { tone: 'danger', label: 'Error' }
}
