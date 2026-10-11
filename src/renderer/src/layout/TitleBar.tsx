import { FlaskConical, PanelLeft, Search } from 'lucide-react'
import { useNavigate } from 'react-router'
import { IconButton, KeyCombo, Tooltip } from '@/components/ui'
import { MOD_LABEL } from '@/hooks/useHotkey'
import { relay } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { usePreferences } from '@/state/preferences'
import { useUi } from '@/state/ui'
import { settingsPath } from '@/app/navigation'
import { BrandMark } from './BrandMark'
import { NotificationCenter } from './NotificationCenter'
import { WindowControls } from './WindowControls'

interface TitleBarProps {
  collapsed: boolean
  onToggleSidebar: () => void
}

export function TitleBar({ collapsed, onToggleSidebar }: TitleBarProps) {
  const { preferences } = usePreferences()
  const { setPaletteOpen } = useUi()
  const navigate = useNavigate()
  const isMac = relay.app.platform === 'darwin'

  return (
    <header className="drag relative z-20 flex h-11 shrink-0 items-center bg-canvas">
      <div
        className={cn(
          'flex h-full shrink-0 items-center gap-2 transition-[width] duration-200 ease-out',
          isMac ? 'pl-[78px]' : 'pl-3.5',
          collapsed ? 'w-[56px]' : 'w-[232px]',
          isMac && collapsed && 'w-[134px]'
        )}
      >
        {!collapsed && (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <BrandMark />
            <span className="truncate text-sm font-semibold tracking-[-0.01em] text-fg">X Auto</span>
          </div>
        )}
        <IconButton
          icon={PanelLeft}
          label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          shortcut={[MOD_LABEL, 'B']}
          onClick={onToggleSidebar}
          className={cn('no-drag', !collapsed && 'mr-1')}
        />
      </div>

      <div className="flex min-w-0 flex-1 justify-center px-4">
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className={cn(
            'no-drag group flex h-7 w-full max-w-[440px] items-center gap-2 rounded-md border border-line bg-surface-1 px-2.5',
            'text-sm text-fg-subtle transition-colors hover:border-line-strong hover:text-fg-muted focus-ring'
          )}
        >
          <Search size={13} strokeWidth={1.9} />
          <span className="flex-1 truncate text-left">Search pages, settings and records</span>
          <KeyCombo keys={[MOD_LABEL, 'K']} className="opacity-80" />
        </button>
      </div>

      <div className="flex h-full shrink-0 items-center gap-1.5 pr-1.5">
        {preferences.showDemoData && (
          <Tooltip content="Sample data is shown. Turn off in Settings → General.">
            <button
              type="button"
              onClick={() => navigate(settingsPath('general'))}
              className="no-drag flex h-6 items-center gap-1.5 rounded-sm border border-warning/25 bg-warning-soft px-2 text-2xs font-medium text-warning transition-colors hover:border-warning/50 focus-ring"
            >
              <FlaskConical size={11} strokeWidth={2} />
              Demo data
            </button>
          </Tooltip>
        )}
        <NotificationCenter />
      </div>

      {!isMac && (
        <>
          <span className="mx-1 h-4 w-px bg-line-strong" aria-hidden />
          <WindowControls />
        </>
      )}
    </header>
  )
}
