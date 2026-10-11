import type { ComponentPropsWithRef, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'

export const fieldSurface =
  'rounded-md border bg-surface-1 text-fg transition-[border-color,box-shadow,background-color] duration-150 ' +
  'placeholder:text-fg-faint hover:border-line-heavy ' +
  'focus-within:border-accent-line focus-within:shadow-[0_0_0_3px_var(--accent-soft)] ' +
  'has-[:disabled]:pointer-events-none has-[:disabled]:opacity-50'

interface InputProps extends Omit<ComponentPropsWithRef<'input'>, 'size'> {
  icon?: LucideIcon
  trailing?: ReactNode
  invalid?: boolean
  size?: 'sm' | 'md'
  wrapperClassName?: string
}

export function Input({ icon: Icon, trailing, invalid, size = 'md', className, wrapperClassName, ...rest }: InputProps) {
  return (
    <div
      className={cn(
        fieldSurface,
        'flex items-center gap-2 px-2.5',
        size === 'sm' ? 'h-7' : 'h-8',
        invalid ? 'border-danger/60' : 'border-line-strong',
        wrapperClassName
      )}
    >
      {Icon && <Icon size={14} strokeWidth={1.8} className="shrink-0 text-fg-subtle" aria-hidden />}
      <input
        aria-invalid={invalid || undefined}
        className={cn(
          'h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-faint',
          className
        )}
        {...rest}
      />
      {trailing}
    </div>
  )
}

interface TextareaProps extends ComponentPropsWithRef<'textarea'> {
  invalid?: boolean
}

export function Textarea({ invalid, className, ...rest }: TextareaProps) {
  return (
    <textarea
      aria-invalid={invalid || undefined}
      className={cn(
        fieldSurface,
        'block w-full resize-none px-3 py-2.5 text-sm leading-relaxed outline-none',
        'focus:border-accent-line focus:shadow-[0_0_0_3px_var(--accent-soft)] disabled:opacity-50',
        invalid ? 'border-danger/60' : 'border-line-strong',
        className
      )}
      {...rest}
    />
  )
}

interface FieldProps {
  label: string
  htmlFor?: string
  hint?: ReactNode
  error?: string | null
  children: ReactNode
  className?: string
  aside?: ReactNode
}

export function Field({ label, htmlFor, hint, error, children, className, aside }: FieldProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={htmlFor} className="text-xs font-medium text-fg-muted">
          {label}
        </label>
        {aside}
      </div>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : (
        hint && <p className="text-xs text-fg-subtle">{hint}</p>
      )}
    </div>
  )
}
