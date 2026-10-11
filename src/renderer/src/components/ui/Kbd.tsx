import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-xs border border-line-strong',
        'bg-surface-3 px-1 font-sans text-2xs font-medium leading-none text-fg-subtle',
        className
      )}
    >
      {children}
    </kbd>
  )
}

/** Renders "Ctrl+K" style combos as separate keycaps. */
export function KeyCombo({ keys, className }: { keys: string[]; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)}>
      {keys.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
    </span>
  )
}
