import { ChevronsUpDown, Info, Keyboard, Monitor, Moon, SlidersHorizontal, Sun } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import type { ThemePreference } from '@shared/types/preferences'
import { MenuItem, MenuLabel, MenuList, MenuSeparator, Popover, SegmentedControl, Tooltip } from '@/components/ui'
import { MOD_LABEL } from '@/hooks/useHotkey'
import { cn } from '@/lib/cn'
import { usePreferences } from '@/state/preferences'
import { useUi } from '@/state/ui'
import { settingsPath } from '@/app/navigation'

function Avatar({ size = 28 }: { size?: number }) {
  return (
    <span
      style={{ width: size, height: size }}
      className="grid shrink-0 place-items-center rounded-md border border-line-strong bg-surface-3 text-2xs font-semibold tracking-wide text-fg-muted"
      aria-hidden
    >
      LW
    </span>
  )
}

/** Sidebar footer entry for preferences, appearance and help. */
export function UserMenu({ collapsed }: { collapsed: boolean }) {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const { preferences, update } = usePreferences()
  const { setShortcutsOpen } = useUi()
  const navigate = useNavigate()
  const close = useCallback(() => setOpen(false), [])

  const go = (to: string) => {
    setOpen(false)
    navigate(to)
  }

  const trigger = (
    <button
      ref={anchorRef}
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label="Workspace and preferences"
      onClick={() => setOpen((value) => !value)}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md p-1.5 text-left transition-colors hover:bg-neutral-soft focus-ring',
        open && 'bg-neutral-soft',
        collapsed && 'justify-center'
      )}
    >
      <Avatar />
      {!collapsed && (
        <>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium text-fg">Local workspace</span>
            <span className="truncate text-2xs text-fg-subtle">Preferences</span>
          </span>
          <ChevronsUpDown size={13} strokeWidth={1.8} className="shrink-0 text-fg-subtle" />
        </>
      )}
    </button>
  )

  return (
    <>
      {collapsed ? (
        <Tooltip content="Workspace and preferences" side="right" className="w-full" disabled={open}>
          {trigger}
        </Tooltip>
      ) : (
        trigger
      )}
      <Popover open={open} onClose={close} anchorRef={anchorRef} align="start" className="w-64">
        <div className="flex items-center gap-2.5 border-b border-line px-3 py-3">
          <Avatar size={32} />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium text-fg">Local workspace</span>
            <span className="truncate text-xs text-fg-subtle">Single user · this device</span>
          </div>
        </div>
        <div className="flex flex-col gap-2 border-b border-line px-3 pb-3 pt-2">
          <MenuLabel>Theme</MenuLabel>
          <SegmentedControl<ThemePreference>
            size="sm"
            aria-label="Theme"
            value={preferences.theme}
            onChange={(theme) => update({ theme })}
            className="w-full [&>button]:flex-1 [&>button]:justify-center"
            options={[
              { value: 'dark', label: 'Dark', icon: Moon },
              { value: 'light', label: 'Light', icon: Sun },
              { value: 'system', label: 'Auto', icon: Monitor }
            ]}
          />
        </div>
        <MenuList label="Workspace menu">
          <MenuItem icon={SlidersHorizontal} shortcut={[MOD_LABEL, ',']} onSelect={() => go(settingsPath('general'))} autoFocus>
            Preferences
          </MenuItem>
          <MenuItem
            icon={Keyboard}
            shortcut={['?']}
            onSelect={() => {
              setOpen(false)
              setShortcutsOpen(true)
            }}
          >
            Keyboard shortcuts
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={Info} onSelect={() => go(settingsPath('security'))}>
            About X Auto
          </MenuItem>
        </MenuList>
      </Popover>
    </>
  )
}
