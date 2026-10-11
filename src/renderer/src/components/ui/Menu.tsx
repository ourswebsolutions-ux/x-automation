import type { LucideIcon } from 'lucide-react'
import type { KeyboardEvent, ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { KeyCombo } from './Kbd'

/** Container that adds arrow-key navigation between its menu items. */
export function MenuList({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')]
    if (!items.length) return
    event.preventDefault()
    const index = items.indexOf(document.activeElement as HTMLElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }
  return (
    <div role="menu" aria-label={label} onKeyDown={onKeyDown} className={cn('flex flex-col p-1', className)}>
      {children}
    </div>
  )
}

interface MenuItemProps {
  icon?: LucideIcon
  children: ReactNode
  onSelect: () => void
  shortcut?: string[]
  tone?: 'default' | 'danger'
  disabled?: boolean
  autoFocus?: boolean
}

export function MenuItem({ icon: Icon, children, onSelect, shortcut, tone = 'default', disabled, autoFocus }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      autoFocus={autoFocus}
      aria-disabled={disabled || undefined}
      onClick={() => !disabled && onSelect()}
      className={cn(
        'flex h-8 w-full items-center gap-2.5 rounded-sm px-2 text-left text-sm outline-none transition-colors',
        'hover:bg-neutral-soft focus-visible:bg-neutral-soft',
        tone === 'danger' ? 'text-danger' : 'text-fg',
        disabled && 'pointer-events-none opacity-40'
      )}
    >
      {Icon && <Icon size={14} strokeWidth={1.8} className={tone === 'danger' ? '' : 'text-fg-subtle'} aria-hidden />}
      <span className="flex-1 truncate">{children}</span>
      {shortcut && <KeyCombo keys={shortcut} />}
    </button>
  )
}

export function MenuSeparator() {
  return <div role="separator" className="-mx-1 my-1 h-px bg-line" />
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2 pb-1 pt-1.5 text-2xs font-medium uppercase tracking-[0.06em] text-fg-subtle">{children}</div>
}
