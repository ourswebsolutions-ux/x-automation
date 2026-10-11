import { Info, TriangleAlert, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

type NoticeTone = 'neutral' | 'accent' | 'warning'

const tones: Record<NoticeTone, { frame: string; icon: string; Icon: LucideIcon }> = {
  neutral: { frame: 'border-line-strong bg-surface-2', icon: 'text-fg-subtle', Icon: Info },
  accent: { frame: 'border-accent-line/60 bg-accent-soft', icon: 'text-accent-text', Icon: Info },
  warning: { frame: 'border-warning/30 bg-warning-soft', icon: 'text-warning', Icon: TriangleAlert }
}

interface NoticeProps {
  tone?: NoticeTone
  icon?: LucideIcon
  title: ReactNode
  children?: ReactNode
  actions?: ReactNode
  className?: string
}

/** Inline, page-level explanation — used for demo-data and phase notices. */
export function Notice({ tone = 'neutral', icon, title, children, actions, className }: NoticeProps) {
  const { frame, icon: iconClass, Icon: DefaultIcon } = tones[tone]
  const Icon = icon ?? DefaultIcon
  return (
    <div className={cn('flex items-start gap-3 rounded-lg border px-3.5 py-3', frame, className)}>
      <Icon size={15} strokeWidth={1.8} className={cn('mt-0.5 shrink-0', iconClass)} aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-sm font-medium text-fg">{title}</p>
        {children && <div className="text-sm text-fg-muted text-pretty">{children}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2 self-center">{actions}</div>}
    </div>
  )
}
