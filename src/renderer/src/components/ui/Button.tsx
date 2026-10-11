import type { ComponentPropsWithRef } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Spinner } from './Spinner'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: LucideIcon
  trailingIcon?: LucideIcon
  loading?: boolean
}

export const buttonBase =
  'relative inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium ' +
  'transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out focus-ring ' +
  'active:translate-y-px disabled:pointer-events-none disabled:opacity-40'

const variants: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-accent-fg shadow-[inset_0_1px_0_rgb(255_255_255/0.2),0_1px_2px_rgb(0_0_0/0.25)] hover:bg-accent-hover',
  secondary:
    'border border-line-strong bg-surface-3 text-fg shadow-raised hover:border-line-heavy hover:bg-surface-4',
  ghost: 'text-fg-muted hover:bg-neutral-soft hover:text-fg',
  danger: 'border border-danger/30 bg-danger-soft text-danger hover:border-danger hover:bg-danger hover:text-white'
}

const sizes: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs',
  md: 'h-8 px-3 text-sm'
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  trailingIcon: TrailingIcon,
  loading = false,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  const iconSize = size === 'sm' ? 13 : 14
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(buttonBase, variants[variant], sizes[size], Icon && 'pl-2.5', className)}
      {...rest}
    >
      {loading ? <Spinner size={iconSize} /> : Icon && <Icon size={iconSize} strokeWidth={1.9} aria-hidden />}
      {children}
      {TrailingIcon && <TrailingIcon size={iconSize} strokeWidth={1.9} className="-mr-0.5 opacity-70" aria-hidden />}
    </button>
  )
}
