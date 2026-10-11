import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description?: ReactNode
  actions?: ReactNode
  size?: 'sm' | 'md'
  className?: string
}

/**
 * Empty state with a layered "card stack" glyph — two hairline frames behind
 * the icon tile suggest the content that will appear here.
 */
export function EmptyState({ icon: Icon, title, description, actions, size = 'md', className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center animate-fade-in',
        size === 'sm' ? 'gap-3 px-4 py-8' : 'gap-4 px-6 py-14',
        className
      )}
    >
      <div className={cn('relative', size === 'sm' ? 'size-10' : 'size-12')} aria-hidden>
        <span className="absolute inset-0 translate-x-2 -translate-y-2 rotate-6 rounded-lg border border-line" />
        <span className="absolute inset-0 translate-x-1 -translate-y-1 rotate-3 rounded-lg border border-line bg-surface-2" />
        <span className="absolute inset-0 grid place-items-center rounded-lg border border-line-strong bg-surface-3 text-fg-muted shadow-raised">
          <Icon size={size === 'sm' ? 16 : 19} strokeWidth={1.6} />
        </span>
      </div>
      <div className="flex max-w-sm flex-col gap-1">
        <p className={cn('font-medium text-fg', size === 'sm' ? 'text-sm' : 'text-base')}>{title}</p>
        {description && <p className="text-sm text-fg-subtle text-pretty">{description}</p>}
      </div>
      {actions && <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{actions}</div>}
    </div>
  )
}
