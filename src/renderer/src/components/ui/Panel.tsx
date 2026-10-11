import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

interface PanelProps {
  title?: ReactNode
  description?: ReactNode
  /** Badges next to the title (e.g. demo / live markers). */
  meta?: ReactNode
  actions?: ReactNode
  children: ReactNode
  footer?: ReactNode
  padded?: boolean
  className?: string
  bodyClassName?: string
}

export function Panel({ title, description, meta, actions, children, footer, padded = true, className, bodyClassName }: PanelProps) {
  return (
    <section className={cn('flex min-w-0 flex-col rounded-lg border border-line bg-surface-2', className)}>
      {(title || actions) && (
        <header className="flex min-h-11 items-center gap-3 border-b border-line px-4 py-2">
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2">
              {title && <h2 className="truncate text-sm font-medium text-fg">{title}</h2>}
              {meta}
            </div>
            {description && <p className="truncate text-xs text-fg-subtle">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
        </header>
      )}
      <div className={cn('min-h-0 flex-1', padded && 'p-4', bodyClassName)}>{children}</div>
      {footer && <footer className="border-t border-line px-4 py-2.5">{footer}</footer>}
    </section>
  )
}
