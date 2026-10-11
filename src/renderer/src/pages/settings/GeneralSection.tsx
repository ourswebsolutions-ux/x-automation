import { RotateCcw } from 'lucide-react'
import { useState } from 'react'
import type { RouteId } from '@shared/config/navigation'
import { LOG_RETENTION_DAYS, type LogRetentionDays } from '@shared/types/preferences'
import { Button, ConfirmDialog, Select, SettingsRow, SettingsSection, Switch, useToast } from '@/components/ui'
import { errorMessage } from '@/lib/bridge'
import { useNotifications } from '@/state/notifications'
import { usePreferences } from '@/state/preferences'
import { useSystem } from '@/state/system'
import { NAV_ORDER } from '@/app/navigation'

export function GeneralSection() {
  const { preferences, update, reset } = usePreferences()
  const toast = useToast()
  const { push } = useNotifications()
  const [confirmReset, setConfirmReset] = useState(false)
  const [resetting, setResetting] = useState(false)
  const { appInfo } = useSystem()
  const loginSupported = appInfo.data?.loginItemSupported ?? false

  const doReset = async () => {
    setResetting(true)
    try {
      await reset()
      push({ tone: 'info', title: 'Preferences reset', body: 'All settings were restored to their defaults.' })
      toast({ tone: 'success', title: 'Preferences reset to defaults' })
      setConfirmReset(false)
    } catch (error) {
      toast({ tone: 'danger', title: 'Reset failed', description: errorMessage(error) })
    } finally {
      setResetting(false)
    }
  }

  return (
    <>
      <SettingsSection title="Workspace" description="How Axora Relay opens and what it shows.">
        <SettingsRow
          label="Start page"
          htmlFor="start-page"
          description="The section shown when the app launches."
          control={
            <Select<RouteId>
              id="start-page"
              className="w-56"
              value={preferences.startPage}
              onChange={(startPage) => update({ startPage })}
              options={NAV_ORDER.map((item) => ({ value: item.id, label: item.label, icon: item.icon }))}
            />
          }
        />
        <SettingsRow
          label="Show demo data"
          htmlFor="demo-data"
          description="Fill the dashboard, accounts and queue with clearly-marked sample records. Turn off to see only the real state of this installation."
          control={
            <Switch id="demo-data" checked={preferences.showDemoData} onChange={(showDemoData) => update({ showDemoData })} />
          }
        />
      </SettingsSection>

      <SettingsSection title="Startup" description="What happens when Axora Relay launches.">
        <SettingsRow
          label="Launch at sign-in"
          htmlFor="launch-at-login"
          description={
            loginSupported
              ? 'Start Axora Relay when you sign in to your computer.'
              : 'Available in the installed app on Windows and macOS. The preference is saved and applied there.'
          }
          control={
            <Switch
              id="launch-at-login"
              checked={preferences.startup.launchAtLogin}
              onChange={(launchAtLogin) => update({ startup: { launchAtLogin } })}
            />
          }
        />
        <SettingsRow
          label="Restore window size and position"
          htmlFor="restore-window"
          description="Reopen where you left off. Off-screen positions are ignored."
          control={
            <Switch
              id="restore-window"
              checked={preferences.startup.restoreWindow}
              onChange={(restoreWindow) => update({ startup: { restoreWindow } })}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Confirmations" description="Ask before actions that lose work. Restores, resets and removals always ask.">
        <SettingsRow
          label="Before deleting a draft"
          htmlFor="confirm-delete-draft"
          control={
            <Switch
              id="confirm-delete-draft"
              checked={preferences.confirmations.deleteDraft}
              onChange={(deleteDraft) => update({ confirmations: { deleteDraft } })}
            />
          }
        />
        <SettingsRow
          label="Before discarding unsaved changes"
          htmlFor="confirm-discard"
          control={
            <Switch
              id="confirm-discard"
              checked={preferences.confirmations.discardChanges}
              onChange={(discardChanges) => update({ confirmations: { discardChanges } })}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Data retention" description="Older entries are removed automatically on launch and every six hours.">
        <SettingsRow
          label="Keep logs and activity for"
          htmlFor="retention"
          description="Drafts and settings are never removed automatically."
          control={
            <Select<string>
              id="retention"
              className="w-40"
              value={String(preferences.retention.logDays)}
              onChange={(value) => update({ retention: { logDays: Number(value) as LogRetentionDays } })}
              options={LOG_RETENTION_DAYS.map((days) => ({ value: String(days), label: days === 365 ? '1 year' : `${days} days` }))}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Reset" description="Restore every preference on this device to its default value.">
        <SettingsRow
          label="Reset all preferences"
          description="Theme, start page, startup, confirmations, retention, notifications and defaults return to their original values. Drafts, provider configurations and keys are not affected."
          control={
            <Button variant="danger" size="sm" icon={RotateCcw} onClick={() => setConfirmReset(true)}>
              Reset…
            </Button>
          }
        />
      </SettingsSection>

      <ConfirmDialog
        open={confirmReset}
        title="Reset all preferences?"
        description="Every setting returns to its default. This can't be undone."
        confirmLabel="Reset preferences"
        tone="danger"
        busy={resetting}
        onCancel={() => setConfirmReset(false)}
        onConfirm={doReset}
      />
    </>
  )
}
