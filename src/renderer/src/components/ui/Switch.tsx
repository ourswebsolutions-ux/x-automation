import { cn } from '@/lib/cn'

interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  id?: string
  'aria-label'?: string
  'aria-describedby'?: string
}

export function Switch({ checked, onChange, disabled, id, ...aria }: SwitchProps) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      {...aria}
      className={cn(
        'relative inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full border transition-colors duration-200 focus-ring',
        'disabled:pointer-events-none disabled:opacity-40',
        checked ? 'border-accent bg-accent' : 'border-line-heavy bg-surface-4 hover:border-fg-faint'
      )}
    >
      <span
        aria-hidden
        className={cn(
          'block size-3 rounded-full shadow-[0_1px_2px_rgb(0_0_0/0.3)] transition-[transform,background-color] duration-200 ease-[var(--ease-spring)]',
          checked ? 'translate-x-[14px] bg-white' : 'translate-x-[2px] bg-fg-muted'
        )}
      />
    </button>
  )
}
