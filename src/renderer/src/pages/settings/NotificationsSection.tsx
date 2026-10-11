import type { NotificationEvent } from '@shared/types/preferences'
import { SettingsSection, Switch } from '@/components/ui'
import { usePreferences } from '@/state/preferences'

const EVENTS: { id: NotificationEvent; label: string; description: string; live: boolean }[] = [
  {
    id: 'systemNotices',
    label: 'System notices',
    description: 'Backups, restores, deleted drafts and other app events.',
    live: true
  },
  {
    id: 'taskFailures',
    label: 'Task failures',
    description: 'When a post could not be published, may need checking on X, or was missed while the app was closed.',
    live: true
  },
  {
    id: 'scheduleReminders',
    label: 'Schedule reminders',
    description: 'Before a scheduled post goes out (the timing is set in Settings → Publishing).',
    live: true
  }
]

export function NotificationsSection() {
  const { preferences, update } = usePreferences()
  return (
    <SettingsSection
      title="Notifications"
      description="Choose where each kind of event appears. Desktop alerts appear while Axora Relay is running."
    >
      <div className="flex items-center gap-4 px-4 py-2 text-2xs font-medium uppercase tracking-[0.06em] text-fg-faint">
        <span className="flex-1">Event</span>
        <span className="w-14 text-center">In-app</span>
        <span className="w-14 text-center">Desktop</span>
      </div>
      {EVENTS.map((event) => {
        const channels = preferences.notifications[event.id]
        return (
          <div key={event.id} className="flex items-center gap-4 px-4 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm text-fg">{event.label}</span>
              <span className="text-xs text-fg-subtle text-pretty">{event.description}</span>
            </div>
            <span className="flex w-14 justify-center">
              <Switch
                checked={channels.inApp}
                aria-label={`${event.label} in-app`}
                onChange={(inApp) => update({ notifications: { [event.id]: { inApp } } })}
              />
            </span>
            <span className="flex w-14 justify-center">
              <Switch
                checked={channels.desktop}
                aria-label={`${event.label} desktop`}
                onChange={(desktop) => update({ notifications: { [event.id]: { desktop } } })}
              />
            </span>
          </div>
        )
      })}
    </SettingsSection>
  )
}
