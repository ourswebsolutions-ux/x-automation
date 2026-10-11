import type { ComponentPropsWithRef } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Tooltip } from './Tooltip'

interface IconButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  icon: LucideIcon
  /** Accessible name, also shown as the tooltip. */
  label: string
  shortcut?: string[]
  size?: 'sm' | 'md'
  active?: boolean
  tooltipSide?: 'top' | 'bottom' | 'left' | 'right'
  showTooltip?: boolean
}

export function IconButton({
  icon: Icon,
  label,
  shortcut,
  size = 'md',
  active = false,
  tooltipSide = 'bottom',
  showTooltip = true,
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  const button = (
    <button
      type={type}
      aria-label={label}
      aria-pressed={active || undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors duration-150 focus-ring',
        'hover:bg-neutral-soft hover:text-fg active:bg-surface-4 disabled:pointer-events-none disabled:opacity-40',
        size === 'sm' ? 'size-6' : 'size-7',
        active && 'bg-neutral-soft text-fg',
        className
      )}
      {...rest}
    >
      <Icon size={size === 'sm' ? 13 : 15} strokeWidth={1.8} aria-hidden />
    </button>
  )
  return showTooltip ? (
    <Tooltip content={label} shortcut={shortcut} side={tooltipSide}>
      {button}
    </Tooltip>
  ) : (
    button
  )
}
