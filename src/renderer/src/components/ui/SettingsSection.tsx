import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

interface SettingsSectionProps {
  id?: string
  title: string
  description?: ReactNode
  meta?: ReactNode
  children: ReactNode
  className?: string
}

export function SettingsSection({ id, title, description, meta, children, className }: SettingsSectionProps) {
  return (
    <section id={id} className={cn('flex flex-col gap-3 scroll-mt-6', className)}>
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-medium text-fg">{title}</h2>
          {meta}
        </div>
        {description && <p className="text-sm text-fg-subtle text-pretty">{description}</p>}
      </div>
      <div className="divide-y divide-line rounded-lg border border-line bg-surface-2">{children}</div>
    </section>
  )
}

interface SettingsRowProps {
  label: string
  description?: ReactNode
  htmlFor?: string
  control?: ReactNode
  children?: ReactNode
  /** Put the control below the label instead of beside it. */
  stacked?: boolean
}

export function SettingsRow({ label, description, htmlFor, control, children, stacked = false }: SettingsRowProps) {
  return (
    <div className={cn('flex gap-4 px-4 py-3.5', stacked ? 'flex-col' : 'items-center justify-between')}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={htmlFor} className="text-sm text-fg">
          {label}
        </label>
        {description && <p className="text-xs text-fg-subtle text-pretty">{description}</p>}
      </div>
      {control && <div className="shrink-0">{control}</div>}
      {children}
    </div>
  )
}
