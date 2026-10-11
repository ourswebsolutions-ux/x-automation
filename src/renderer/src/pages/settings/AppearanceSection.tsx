import { Monitor, Moon, Sun } from 'lucide-react'
import type { ThemePreference } from '@shared/types/preferences'
import { SegmentedControl, SettingsRow, SettingsSection, StatusBadge, Switch } from '@/components/ui'
import { usePreferences } from '@/state/preferences'

export function AppearanceSection() {
  const { preferences, update } = usePreferences()
  return (
    <SettingsSection title="Appearance" description="Theme and motion. Changes apply instantly.">
      <SettingsRow
        label="Theme"
        description={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            Dark is the reference theme. Light is a complete preview and will be refined in a later phase.
            <StatusBadge tone="info">Light preview</StatusBadge>
          </span>
        }
        control={
          <SegmentedControl<ThemePreference>
            aria-label="Theme"
            value={preferences.theme}
            onChange={(theme) => update({ theme })}
            options={[
              { value: 'dark', label: 'Dark', icon: Moon },
              { value: 'light', label: 'Light', icon: Sun },
              { value: 'system', label: 'System', icon: Monitor }
            ]}
          />
        }
      />
      <SettingsRow
        label="Reduce motion"
        htmlFor="reduce-motion"
        description="Minimise animations and transitions. Your operating system setting is always respected too."
        control={<Switch id="reduce-motion" checked={preferences.reduceMotion} onChange={(reduceMotion) => update({ reduceMotion })} />}
      />
      <SettingsRow
        label="Collapse sidebar"
        htmlFor="sidebar-collapsed"
        description="Show icons only. Narrow windows collapse the sidebar automatically."
        control={
          <Switch
            id="sidebar-collapsed"
            checked={preferences.sidebarCollapsed}
            onChange={(sidebarCollapsed) => update({ sidebarCollapsed })}
          />
        }
      />
    </SettingsSection>
  )
}
