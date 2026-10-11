import { useEffect, useRef, useState } from 'react'
import { ENGAGEMENT_LIMITS } from '@shared/types/links'
import { PUBLISHING_LIMITS, type PublishingSettings } from '@shared/types/publishing'
import { Input, SettingsRow, SettingsSection, Skeleton, Switch, useToast } from '@/components/ui'
import { useEngagementSettings } from '@/data/links'
import { usePublishingSettings } from '@/data/publishing'
import { errorMessage, relay } from '@/lib/bridge'

type NumericKey = keyof typeof PUBLISHING_LIMITS

/** A whole-number setting saved when the field loses focus (or on Enter). */
function NumberSetting({ id, value, unit, limits, onSave }: { id: string; value: number; unit: string; limits: readonly [number, number]; onSave: (value: number) => Promise<void> }) {
  const [text, setText] = useState(String(value))
  const [error, setError] = useState<string | null>(null)
  const focused = useRef(false)
  // Follow the saved value, but never overwrite what the user is typing (a late save can land mid-edit).
  useEffect(() => {
    if (!focused.current) setText(String(value))
  }, [value])
  // Reads the field's current value (not render state), so Enter right after typing validates what was typed.
  const commit = async (raw: string) => {
    const next = Number(raw)
    if (!/^\d+$/.test(raw) || next < limits[0] || next > limits[1]) {
      setError(`${limits[0]}–${limits[1]}`)
      return
    }
    setError(null)
    if (next !== value) await onSave(next)
  }
  return (
    <span className="flex flex-col items-end gap-1">
      <Input
        id={id}
        inputMode="numeric"
        value={text}
        invalid={Boolean(error)}
        onChange={(e) => setText(e.target.value.replace(/\D/g, ''))}
        onFocus={() => (focused.current = true)}
        onBlur={(e) => {
          focused.current = false
          void commit(e.currentTarget.value)
        }}
        onKeyDown={(e) => e.key === 'Enter' && void commit(e.currentTarget.value)}
        trailing={<span className="text-xs text-fg-faint">{unit}</span>}
        wrapperClassName="w-32"
        className="tabular text-right"
      />
      {error && <span className="text-2xs text-danger">Use {error}</span>}
    </span>
  )
}

export function PublishingSection() {
  const toast = useToast()
  const settings = usePublishingSettings()
  const engagement = useEngagementSettings()
  const save = async (patch: Partial<PublishingSettings>) => {
    try {
      settings.setData(await relay.publishing.updateSettings(patch))
      toast({ tone: 'success', title: 'Saved' })
    } catch (error) {
      toast({ tone: 'danger', title: 'Not saved', description: errorMessage(error) })
    }
  }
  const s = settings.data
  if (!s) return <Skeleton className="h-64" />
  const number = (key: NumericKey, unit: string) => <NumberSetting id={`publishing-${key}`} value={s[key]} unit={unit} limits={PUBLISHING_LIMITS[key]} onSave={(value) => save({ [key]: value })} />

  return (
    <div className="flex flex-col gap-8">
      <SettingsSection title="Publishing" description="How scheduled posts go out. Axora Relay publishes only while it is running.">
        <SettingsRow
          label="Space posts from one account"
          htmlFor="publishing-spacingMinutes"
          description="Posts from the same account wait at least this long after the previous one. 0 posts them back to back."
          control={number('spacingMinutes', 'min')}
        />
        <SettingsRow
          label="Late posts"
          htmlFor="publishing-missedGraceMinutes"
          description="If the app was closed or the computer asleep, a post up to this late still goes out. Later ones wait for you to decide."
          control={number('missedGraceMinutes', 'min')}
        />
        <SettingsRow
          label="Reminder before a post goes out"
          htmlFor="publishing-reminderMinutes"
          description="Shown in the notification centre (and on the desktop if enabled in Notifications). 0 turns reminders off."
          control={number('reminderMinutes', 'min')}
        />
        <SettingsRow
          label="Attempts when nothing was posted"
          htmlFor="publishing-maxAttempts"
          description="For problems that happen before posting, like a profile that would not open. A post that may already be on X is never retried automatically."
          control={number('maxAttempts', 'tries')}
        />
        <SettingsRow
          label="Wait before retrying"
          htmlFor="publishing-retryDelayMinutes"
          description="After a problem that happened before posting. Each further try waits five times longer, up to an hour."
          control={number('retryDelayMinutes', 'min')}
        />
        <SettingsRow
          label="Close the profile after publishing"
          htmlFor="publishing-close"
          description="Only profiles Axora Relay opened for the post are closed. Profiles you opened stay open."
          control={<Switch id="publishing-close" checked={s.closeProfileAfterPublish} onChange={(checked) => void save({ closeProfileAfterPublish: checked })} aria-label="Close the profile after publishing" />}
        />
      </SettingsSection>

      <SettingsSection title="Engagement tasks" description="Engagement tasks are reminders you act on yourself. Axora Relay never likes, reposts, replies or follows on its own.">
        <SettingsRow
          label="Daily guideline per account"
          htmlFor="engagement-daily"
          description="New tasks for an account are refused once it has this many for one day. Keeps activity paced like a person’s. 0 turns the guideline off."
          control={
            engagement.data ? (
              <NumberSetting
                id="engagement-daily"
                value={engagement.data.dailyLimitPerAccount}
                unit="tasks"
                limits={ENGAGEMENT_LIMITS.dailyLimitPerAccount}
                onSave={async (value) => {
                  try {
                    engagement.setData(await relay.engagement.updateSettings({ dailyLimitPerAccount: value }))
                    toast({ tone: 'success', title: 'Saved' })
                  } catch (error) {
                    toast({ tone: 'danger', title: 'Not saved', description: errorMessage(error) })
                  }
                }}
              />
            ) : (
              <Skeleton className="h-8 w-32" />
            )
          }
        />
      </SettingsSection>
    </div>
  )
}
