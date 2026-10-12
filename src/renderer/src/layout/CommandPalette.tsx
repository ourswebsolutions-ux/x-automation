import { CornerDownLeft, FileText, FlaskConical, Keyboard, Moon, PanelLeft, Search, SlidersHorizontal, SquarePen, Sun, UsersRound, ListChecks, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'
import type { Account } from '@shared/types/accounts'
import type { Draft } from '@shared/types/domain'
import { EmptyState, Kbd } from '@/components/ui'
import { useMountTransition } from '@/hooks/useMountTransition'
import { relay } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { DEMO_ACCOUNTS, DEMO_TASKS } from '@/data/demo'
import { NAV_ORDER, settingsPath, type SettingsSectionId } from '@/app/navigation'
import { usePreferences } from '@/state/preferences'
import { useUi } from '@/state/ui'

interface PaletteItem {
  id: string
  group: 'Pages' | 'Actions' | 'Settings' | 'Accounts' | 'Drafts' | 'Demo accounts' | 'Demo tasks'
  label: string
  hint?: string
  icon: LucideIcon
  keywords?: string
  run: () => void
}

const SETTINGS_SECTIONS: { id: SettingsSectionId; label: string; keywords: string }[] = [
  { id: 'general', label: 'General', keywords: 'start page demo data reset startup login confirmations retention' },
  { id: 'appearance', label: 'Appearance', keywords: 'theme dark light motion sidebar' },
  { id: 'notifications', label: 'Notifications', keywords: 'alerts failures reminders desktop' },
  { id: 'automation', label: 'Automation', keywords: 'engine publishing schedule spacing reminders missed retry queue engagement' },
  { id: 'ai', label: 'AI providers & keys', keywords: 'openai model text image keys api' },
  { id: 'ixbrowser', label: 'IX Browser', keywords: 'profiles local api endpoint connection' },
  { id: 'proxies', label: 'Proxies', keywords: 'proxy default socks http' },
  { id: 'usage', label: 'Usage & costs', keywords: 'tokens cost spend limits rates requests' },
  { id: 'backup', label: 'Backup & restore', keywords: 'export import recovery restore automatic' },
  { id: 'security', label: 'Security & app info', keywords: 'isolation sandbox credentials encryption keys vault version about diagnostics database' }
]

/** Scores an item: prefix match > word match > substring > subsequence. */
function score(item: PaletteItem, query: string): number {
  const label = item.label.toLowerCase()
  const haystack = `${label} ${item.keywords ?? ''} ${item.hint ?? ''}`.toLowerCase()
  if (label.startsWith(query)) return 4
  if (label.split(/[\s&@_]+/).some((word) => word.startsWith(query))) return 3
  if (haystack.includes(query)) return 2
  let i = 0
  for (const char of label) if (char === query[i]) i++
  return i === query.length ? 1 : 0
}

export function CommandPalette() {
  const { paletteOpen: open, setPaletteOpen, setShortcutsOpen } = useUi()
  const { preferences, resolvedTheme, update } = usePreferences()
  const { mounted, visible } = useMountTransition(open, 120)
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const listRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement as HTMLElement | null
    setQuery('')
    setActive(0)
    relay.drafts.list().then(setDrafts, () => setDrafts([]))
    relay.accounts.list().then(setAccounts, () => setAccounts([]))
    return () => restoreRef.current?.focus?.()
  }, [open])

  const close = () => setPaletteOpen(false)

  const items = useMemo<PaletteItem[]>(() => {
    const go = (to: string) => () => navigate(to)
    const list: PaletteItem[] = [
      ...NAV_ORDER.map((nav) => ({
        id: `page-${nav.id}`,
        group: 'Pages' as const,
        label: nav.label,
        hint: nav.description,
        icon: nav.icon,
        keywords: nav.keywords.join(' '),
        run: go(nav.path)
      })),
      { id: 'act-draft', group: 'Actions', label: 'New post', hint: 'Write a post', icon: SquarePen, keywords: 'compose write tweet create draft', run: go('/create') },
      {
        id: 'act-theme',
        group: 'Actions',
        label: resolvedTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
        icon: resolvedTheme === 'dark' ? Sun : Moon,
        keywords: 'theme appearance mode',
        run: () => void update({ theme: resolvedTheme === 'dark' ? 'light' : 'dark' })
      },
      {
        id: 'act-demo',
        group: 'Actions',
        label: preferences.showDemoData ? 'Hide demo data' : 'Show demo data',
        icon: FlaskConical,
        keywords: 'sample preview live',
        run: () => void update({ showDemoData: !preferences.showDemoData })
      },
      {
        id: 'act-sidebar',
        group: 'Actions',
        label: preferences.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar',
        icon: PanelLeft,
        keywords: 'navigation',
        run: () => void update({ sidebarCollapsed: !preferences.sidebarCollapsed })
      },
      { id: 'act-keys', group: 'Actions', label: 'Keyboard shortcuts', icon: Keyboard, keywords: 'hotkeys keys help', run: () => setShortcutsOpen(true) },
      ...SETTINGS_SECTIONS.map((section) => ({
        id: `set-${section.id}`,
        group: 'Settings' as const,
        label: section.label,
        hint: 'Settings',
        icon: SlidersHorizontal,
        keywords: section.keywords,
        run: go(settingsPath(section.id))
      })),
      ...accounts.map((account) => ({
        id: `account-${account.id}`,
        group: 'Accounts' as const,
        label: account.label,
        hint: account.handle ? `@${account.handle}` : account.profile ? `#${account.profile.externalId}` : 'Account',
        icon: UsersRound,
        keywords: `${account.handle ?? ''} ${account.profile?.name ?? ''} ${account.profile?.externalId ?? ''}`,
        run: go(`/accounts?view=accounts&q=${encodeURIComponent(account.label)}`)
      })),
      ...drafts.map((draft) => ({
        id: `draft-${draft.id}`,
        group: 'Drafts' as const,
        label: draft.body.replace(/\s+/g, ' ').slice(0, 80),
        hint: 'Session draft',
        icon: FileText,
        run: go(`/create?draft=${draft.id}`)
      }))
    ]
    if (preferences.showDemoData) {
      list.push(
        ...DEMO_ACCOUNTS.map((account) => ({
          id: account.id,
          group: 'Demo accounts' as const,
          label: `@${account.handle}`,
          hint: account.displayName,
          icon: UsersRound,
          keywords: `${account.group} ${account.tags.join(' ')}`,
          run: go(`/accounts?view=accounts&q=${encodeURIComponent(account.handle)}`)
        })),
        ...DEMO_TASKS.map((task) => ({
          id: task.id,
          group: 'Demo tasks' as const,
          label: task.label,
          hint: task.status,
          icon: ListChecks,
          keywords: task.kind,
          run: go(`/queue?q=${encodeURIComponent(task.label)}`)
        }))
      )
    }
    return list
  }, [navigate, resolvedTheme, preferences.showDemoData, preferences.sidebarCollapsed, update, setShortcutsOpen, drafts, accounts])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items.filter((item) => item.group === 'Pages' || item.group === 'Actions')
    return items
      .map((item) => ({ item, s: score(item, q) }))
      .filter((entry) => entry.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((entry) => entry.item)
  }, [items, query])

  // Group while keeping score order within each group.
  const grouped = useMemo(() => {
    const map = new Map<string, PaletteItem[]>()
    for (const item of results) map.set(item.group, [...(map.get(item.group) ?? []), item])
    return [...map.entries()]
  }, [results])
  const flat = grouped.flatMap(([, list]) => list)

  useEffect(() => setActive(0), [query])
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const runItem = (item: PaletteItem | undefined) => {
    if (!item) return
    close()
    item.run()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((index) => (flat.length ? (index + 1) % flat.length : 0))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((index) => (flat.length ? (index - 1 + flat.length) % flat.length : 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      runItem(flat[active])
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  }

  if (!mounted) return null
  let index = -1

  return createPortal(
    <div className="fixed inset-0 z-[130] flex justify-center px-4 pt-[14vh]" onKeyDown={onKeyDown}>
      <div aria-hidden onClick={close} className={cn('fixed inset-0 bg-scrim transition-opacity duration-150', visible ? 'opacity-100' : 'opacity-0')} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className={cn(
          'relative flex h-fit max-h-[min(560px,70vh)] w-full max-w-[600px] flex-col overflow-hidden rounded-xl bg-overlay shadow-dialog',
          'transition-[opacity,transform] duration-150 ease-out',
          visible ? 'translate-y-0 scale-100 opacity-100' : '-translate-y-1 scale-[0.99] opacity-0'
        )}
      >
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
          <Search size={16} strokeWidth={1.8} className="text-fg-subtle" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search pages, actions, settings and records…"
            aria-label="Search"
            aria-controls="palette-results"
            aria-activedescendant={flat[active] ? `palette-${flat[active].id}` : undefined}
            className="h-full flex-1 bg-transparent text-base text-fg outline-none placeholder:text-fg-faint"
          />
          <Kbd>Esc</Kbd>
        </div>

        <div ref={listRef} id="palette-results" role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {flat.length === 0 ? (
            <EmptyState size="sm" icon={Search} title={`No matches for “${query.trim()}”`} description="Try a page name, a setting, or an account handle." />
          ) : (
            grouped.map(([group, list]) => (
              <div key={group} role="group" aria-label={group} className="pb-1">
                <div className="px-2.5 pb-1 pt-2 text-2xs font-medium uppercase tracking-[0.07em] text-fg-faint">{group}</div>
                {list.map((item) => {
                  index++
                  const i = index
                  const Icon = item.icon
                  return (
                    <div
                      key={item.id}
                      id={`palette-${item.id}`}
                      data-index={i}
                      role="option"
                      aria-selected={i === active}
                      onPointerMove={() => setActive(i)}
                      onClick={() => runItem(item)}
                      className={cn(
                        'flex h-9 items-center gap-3 rounded-md px-2.5 text-sm',
                        i === active ? 'bg-neutral-soft text-fg' : 'text-fg-muted'
                      )}
                    >
                      <Icon size={15} strokeWidth={1.8} className={i === active ? 'text-accent-text' : 'text-fg-subtle'} />
                      <span className="min-w-0 shrink truncate">{item.label}</span>
                      {item.hint && <span className="min-w-0 flex-1 truncate text-xs text-fg-faint">{item.hint}</span>}
                      {i === active && <CornerDownLeft size={13} strokeWidth={1.8} className="ml-auto shrink-0 text-fg-subtle" />}
                    </div>
                  )
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex h-9 shrink-0 items-center gap-4 border-t border-line px-4 text-2xs text-fg-subtle">
          <span className="flex items-center gap-1.5"><Kbd>↑</Kbd><Kbd>↓</Kbd> Navigate</span>
          <span className="flex items-center gap-1.5"><Kbd>↵</Kbd> Open</span>
          {preferences.showDemoData && <span className="ml-auto text-warning/80">Includes demo records</span>}
        </div>
      </div>
    </div>,
    document.body
  )
}
