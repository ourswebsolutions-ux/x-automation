import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useIndicator } from '@/hooks/useIndicator'

export interface SegmentOption<V extends string> {
  value: V
  label: string
  icon?: LucideIcon
}

interface SegmentedControlProps<V extends string> {
  value: V
  onChange: (value: V) => void
  options: SegmentOption<V>[]
  size?: 'sm' | 'md'
  disabled?: boolean
  className?: string
  'aria-label'?: string
}

export function SegmentedControl<V extends string>({
  value,
  onChange,
  options,
  size = 'md',
  disabled = false,
  className,
  ...aria
}: SegmentedControlProps<V>) {
  const { containerRef, rect } = useIndicator<HTMLDivElement>(value, [options.length])

  return (
    <div
      ref={containerRef}
      role="radiogroup"
      aria-label={aria['aria-label']}
      aria-disabled={disabled || undefined}
      className={cn(
        'relative inline-flex items-center rounded-md border border-line bg-surface-1 p-0.5',
        disabled && 'opacity-50',
        size === 'sm' ? 'h-7' : 'h-8',
        className
      )}
    >
      {rect && (
        <span
          aria-hidden
          className="absolute inset-y-0.5 left-0 rounded-[5px] border border-line-strong bg-surface-4 shadow-raised transition-[transform,width] duration-250 ease-out"
          style={{ width: rect.width, transform: `translateX(${rect.left}px)` }}
        />
      )}
      {options.map(({ value: optionValue, label, icon: Icon }) => {
        const selected = optionValue === value
        return (
          <button
            key={optionValue}
            data-key={optionValue}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(optionValue)}
            className={cn(
              'relative z-10 flex h-full items-center gap-1.5 rounded-[5px] px-2.5 font-medium transition-colors focus-ring',
              size === 'sm' ? 'text-xs' : 'text-sm',
              selected ? 'text-fg' : 'text-fg-subtle hover:text-fg-muted'
            )}
          >
            {Icon && <Icon size={13} strokeWidth={1.9} aria-hidden />}
            {label}
          </button>
        )
      })}
    </div>
  )
}
