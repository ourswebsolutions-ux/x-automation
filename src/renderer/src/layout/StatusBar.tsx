import { useNavigate } from 'react-router'
import type { IntegrationId } from '@shared/types/integrations'
import { StatusDot, Tooltip } from '@/components/ui'
import { INTEGRATION_STATE } from '@/lib/status'
import { usePreferences } from '@/state/preferences'
import { useSystem } from '@/state/system'
import { settingsPath, type SettingsSectionId } from '@/app/navigation'
import { useAutomation } from '@/data/publishing'

const SHORT_NAMES: Partial<Record<IntegrationId, string>> = {
  ixbrowser: 'IX Browser',
  'text-ai': 'AI text',
  database: 'Storage'
}

const TARGET: Partial<Record<IntegrationId, SettingsSectionId>> = { ixbrowser: 'ixbrowser', 'text-ai': 'ai', database: 'security' }
const AUTOMATION = { running: { tone: 'success', label: 'Running' }, idle: { tone: 'neutral', label: 'Ready' }, paused: { tone: 'warning', label: 'Paused' } } as const

/** Bottom strip with real integration states, automation state, demo flag and version. */
export function StatusBar() {
  const { integrations, appInfo } = useSystem()
  const { preferences } = usePreferences()
  const navigate = useNavigate()
  const shown = (integrations.data ?? []).filter((item) => item.id in SHORT_NAMES)
  const automation = useAutomation()
  const auto = automation.data ? AUTOMATION[automation.data.state] : null

  return (
    <footer className="flex h-7 shrink-0 items-center gap-1 border-t border-line bg-canvas px-2 text-2xs text-fg-subtle">
      {integrations.status === 'error' ? (
        <span className="flex items-center gap-1.5 px-1.5">
          <StatusDot tone="danger" /> Status unavailable
        </span>
      ) : (
        shown.map((item) => {
          const meta = INTEGRATION_STATE[item.state]
          return (
            <Tooltip key={item.id} content={item.detail} side="top">
              <button
                type="button"
                onClick={() => navigate(settingsPath(TARGET[item.id] ?? 'ai'))}
                className="flex h-5 items-center gap-1.5 rounded-xs px-1.5 transition-colors hover:bg-neutral-soft hover:text-fg-muted focus-ring"
              >
                <StatusDot tone={meta.tone} />
                <span className="text-fg-muted">{SHORT_NAMES[item.id]}</span>
                <span>{item.id === 'database' ? (item.state === 'available' ? 'SQLite' : 'Needs attention') : meta.label}</span>
              </button>
            </Tooltip>
          )
        })
      )}
      {auto && (
        <button
          type="button"
          onClick={() => navigate('/queue')}
          className="flex h-5 items-center gap-1.5 rounded-xs px-1.5 transition-colors hover:bg-neutral-soft hover:text-fg-muted focus-ring"
        >
          <StatusDot tone={auto.tone} />
          <span className="text-fg-muted">Automation</span>
          <span>{auto.label}</span>
        </button>
      )}
      <span className="flex-1" />
      {preferences.showDemoData && (
        <span className="flex items-center gap-1.5 px-1.5 text-warning">
          <StatusDot tone="warning" /> Demo data on
        </span>
      )}
      {appInfo.data && (
        <span className="tabular px-1.5">
          v{appInfo.data.version} · Phase {appInfo.data.phase}
          {!appInfo.data.isPackaged && ' · dev'}
        </span>
      )}
    </footer>
  )
}
