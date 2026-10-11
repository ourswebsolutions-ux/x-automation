import { useEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router'
import { ErrorBoundary } from '@/components/ui'
import { useHotkey } from '@/hooks/useHotkey'
import { useWindowWidth } from '@/hooks/useWindowWidth'
import { usePreferences } from '@/state/preferences'
import { useUi } from '@/state/ui'
import { NAV_ORDER, settingsPath } from '@/app/navigation'
import { CommandPalette } from './CommandPalette'
import { NoticeBridge } from './NoticeBridge'
import { ShortcutsDialog } from './ShortcutsDialog'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'
import { TitleBar } from './TitleBar'

/** Below this width the sidebar collapses automatically. */
const AUTO_COLLAPSE_WIDTH = 1120

export function AppShell() {
  const { preferences, update } = usePreferences()
  const { setPaletteOpen, setShortcutsOpen } = useUi()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const width = useWindowWidth()
  const scrollRef = useRef<HTMLDivElement>(null)

  // Narrow windows collapse the sidebar without overwriting the saved preference.
  const autoCollapsed = width < AUTO_COLLAPSE_WIDTH
  const [expandedWhileNarrow, setExpandedWhileNarrow] = useState(false)
  const collapsed = autoCollapsed ? !expandedWhileNarrow : preferences.sidebarCollapsed
  useEffect(() => {
    if (!autoCollapsed) setExpandedWhileNarrow(false)
  }, [autoCollapsed])

  const toggleSidebar = () => {
    if (autoCollapsed) setExpandedWhileNarrow((value) => !value)
    else void update({ sidebarCollapsed: !preferences.sidebarCollapsed })
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [pathname])

  useHotkey('mod+k', () => setPaletteOpen(true), { allowInInputs: true })
  useHotkey('mod+n', () => navigate('/create'))
  useHotkey('mod+,', () => navigate(settingsPath('general')))
  useHotkey('mod+b', toggleSidebar)
  useHotkey('shift+?', () => setShortcutsOpen(true))

  // Ctrl/⌘ + 1…9 jumps to the matching section in sidebar order.
  useEffect(() => {
    const isMac = navigator.userAgent.includes('Mac')
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(isMac ? event.metaKey : event.ctrlKey) || event.shiftKey || event.altKey) return
      const target = NAV_ORDER[Number(event.key) - 1]
      if (!target) return
      event.preventDefault()
      navigate(target.path)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [navigate])

  return (
    <div className="flex h-full flex-col bg-canvas">
      <TitleBar collapsed={collapsed} onToggleSidebar={toggleSidebar} />
      <div className="flex min-h-0 flex-1">
        <Sidebar collapsed={collapsed} />
        <main className="relative min-w-0 flex-1 overflow-hidden rounded-tl-xl border-l border-t border-line bg-surface-1">
          <div ref={scrollRef} className="@container h-full overflow-y-auto">
            <div key={pathname} className="mx-auto w-full max-w-[1320px] px-6 pb-12 pt-6 animate-rise @3xl:px-8 @3xl:pt-7">
              <ErrorBoundary resetKey={pathname}>
                <Outlet />
              </ErrorBoundary>
            </div>
          </div>
        </main>
      </div>
      <StatusBar />
      <NoticeBridge />
      <CommandPalette />
      <ShortcutsDialog />
    </div>
  )
}
