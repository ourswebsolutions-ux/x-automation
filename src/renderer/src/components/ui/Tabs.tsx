import type { LucideIcon } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import { cn } from '@/lib/cn'
import { useIndicator } from '@/hooks/useIndicator'

export interface TabItem<V extends string> {
  value: V
  label: string
  count?: number
  icon?: LucideIcon
}

interface TabsProps<V extends string> {
  value: V
  onChange: (value: V) => void
  items: TabItem<V>[]
  className?: string
  'aria-label'?: string
}

/** Underline tabs with a gliding indicator and roving arrow-key focus. */
export function Tabs<V extends string>({ value, onChange, items, className, ...aria }: TabsProps<V>) {
  const { containerRef, rect } = useIndicator<HTMLDivElement>(value, [items.length])

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    const index = items.findIndex((item) => item.value === value)
    const next = items[(index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length]
    if (!next) return
    onChange(next.value)
    containerRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(next.value)}"]`)?.focus()
  }

  return (
    <div
      ref={containerRef}
      role="tablist"
      aria-label={aria['aria-label']}
      onKeyDown={onKeyDown}
      className={cn('relative flex items-center gap-5 border-b border-line', className)}
    >
      {items.map(({ value: itemValue, label, count, icon: Icon }) => {
        const selected = itemValue === value
        return (
          <button
            key={itemValue}
            data-key={itemValue}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(itemValue)}
            className={cn(
              'relative -mb-px flex h-9 items-center gap-1.5 rounded-xs text-sm transition-colors focus-ring',
              selected ? 'text-fg' : 'text-fg-subtle hover:text-fg-muted'
            )}
          >
            {Icon && <Icon size={14} strokeWidth={1.8} aria-hidden />}
            {label}
            {count !== undefined && (
              <span
                className={cn(
                  'tabular rounded-xs px-1 text-2xs font-medium',
                  selected ? 'bg-neutral-soft text-fg-muted' : 'text-fg-faint'
                )}
              >
                {count}
              </span>
            )}
          </button>
        )
      })}
      {rect && (
        <span
          aria-hidden
          className="absolute -bottom-px h-[2px] rounded-full bg-accent transition-[transform,width] duration-300 ease-out"
          style={{ width: rect.width, transform: `translateX(${rect.left}px)` }}
        />
      )}
    </div>
  )
}
