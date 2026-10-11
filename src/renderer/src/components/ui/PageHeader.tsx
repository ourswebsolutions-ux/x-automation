import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

interface PageHeaderProps {
  title: string
  description?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  className?: string
}

export function PageHeader({ title, description, meta, actions, className }: PageHeaderProps) {
  return (
    <header className={cn('flex flex-wrap items-end justify-between gap-x-6 gap-y-3', className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-2.5">
          <h1 className="text-xl font-semibold tracking-[-0.015em] text-fg">{title}</h1>
          {meta}
        </div>
        {description && <p className="max-w-2xl text-sm text-fg-subtle text-pretty">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  )
}
