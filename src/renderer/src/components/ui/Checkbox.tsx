import { Check, Minus } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/cn'

interface CheckboxProps {
  checked: boolean
  /** Shows a dash: some, not all, of a group is selected. */
  indeterminate?: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  id?: string
  className?: string
  'aria-label'?: string
  'aria-describedby'?: string
}

/** Native checkbox (keyboard and screen-reader behaviour for free) with a token-styled box. */
export function Checkbox({ checked, indeterminate = false, onChange, disabled, id, className, ...aria }: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate
  }, [indeterminate])
  const on = checked || indeterminate
  const Mark = indeterminate ? Minus : Check

  return (
    <span className={cn('relative inline-grid size-4 shrink-0 place-items-center', className)}>
      <input
        ref={ref}
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        onClick={(event) => event.stopPropagation()}
        className="peer absolute inset-0 m-0 cursor-pointer appearance-none rounded-[4px] disabled:cursor-default"
        {...aria}
      />
      <span
        aria-hidden
        className={cn(
          'pointer-events-none grid size-4 place-items-center rounded-[4px] border transition-[background-color,border-color] duration-150',
          'peer-focus-visible:shadow-[0_0_0_2px_var(--surface-2),0_0_0_4px_var(--accent-line)] peer-disabled:opacity-40',
          on ? 'border-accent bg-accent text-accent-fg' : 'border-line-heavy bg-surface-1 peer-hover:border-fg-faint'
        )}
      >
        <Mark size={11} strokeWidth={3} className={cn('transition-[opacity,transform] duration-150', on ? 'scale-100 opacity-100' : 'scale-50 opacity-0')} />
      </span>
    </span>
  )
}
