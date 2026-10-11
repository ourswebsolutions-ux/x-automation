import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'

const toneClasses: Record<Tone, string> = {
  neutral: 'bg-neutral-soft text-fg-muted',
  accent: 'bg-accent-soft text-accent-text',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info'
}

const dotClasses: Record<Tone, string> = {
  neutral: 'bg-fg-subtle text-fg-subtle',
  accent: 'bg-accent text-accent',
  success: 'bg-success text-success',
  warning: 'bg-warning text-warning',
  danger: 'bg-danger text-danger',
  info: 'bg-info text-info'
}

interface StatusBadgeProps {
  tone?: Tone
  children: ReactNode
  dot?: boolean
  pulse?: boolean
  icon?: LucideIcon
  variant?: 'soft' | 'outline'
  className?: string
}

export function StatusBadge({
  tone = 'neutral',
  children,
  dot = false,
  pulse = false,
  icon: Icon,
  variant = 'soft',
  className
}: StatusBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xs px-1.5 text-2xs font-medium',
        variant === 'soft' ? toneClasses[tone] : 'border border-line-strong text-fg-subtle',
        className
      )}
    >
      {dot && <StatusDot tone={tone} pulse={pulse} />}
      {Icon && <Icon size={11} strokeWidth={2} aria-hidden />}
      {children}
    </span>
  )
}

export function StatusDot({ tone = 'neutral', pulse = false, className }: { tone?: Tone; pulse?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block size-1.5 shrink-0 rounded-full', dotClasses[tone], pulse && 'animate-pulse-dot', className)}
    />
  )
}
