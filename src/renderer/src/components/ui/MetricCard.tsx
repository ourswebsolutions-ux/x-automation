import { ArrowUpRight, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { formatNumber } from '@/lib/format'
import { Skeleton } from './Skeleton'

interface MetricCardProps {
  label: string
  value: number | null
  icon: LucideIcon
  hint?: ReactNode
  loading?: boolean
  onClick?: () => void
  className?: string
}

/** Key figure tile. Clickable cards reveal an arrow and navigate. */
export function MetricCard({ label, value, icon: Icon, hint, loading, onClick, className }: MetricCardProps) {
  const interactive = Boolean(onClick)
  const Root = interactive ? 'button' : 'div'
  return (
    <Root
      type={interactive ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'group relative flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface-2 p-4 text-left',
        'shadow-[inset_0_1px_0_var(--highlight)]',
        interactive && 'transition-[border-color,background-color] duration-150 hover:border-line-strong hover:bg-surface-3 focus-ring',
        className
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-xs font-medium text-fg-muted">
          <Icon size={14} strokeWidth={1.8} className="text-fg-subtle" aria-hidden />
          {label}
        </span>
        {interactive && (
          <ArrowUpRight
            size={14}
            strokeWidth={1.8}
            aria-hidden
            className="-translate-x-0.5 translate-y-0.5 text-fg-faint opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:translate-y-0 group-hover:text-fg-muted group-hover:opacity-100"
          />
        )}
      </div>
      {loading || value === null ? (
        <Skeleton className="h-7 w-16" />
      ) : (
        <span className="tabular text-2xl font-semibold tracking-[-0.02em] text-fg">{formatNumber(value)}</span>
      )}
      <div className="min-h-4 truncate text-xs text-fg-subtle">{loading ? <Skeleton className="h-2.5 w-28" /> : hint}</div>
    </Root>
  )
}
