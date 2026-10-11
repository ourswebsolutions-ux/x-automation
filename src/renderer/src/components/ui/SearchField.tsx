import { Search, X } from 'lucide-react'
import { useRef } from 'react'
import { Input } from './Input'

interface SearchFieldProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  size?: 'sm' | 'md'
  autoFocus?: boolean
  'aria-label'?: string
}

export function SearchField({ value, onChange, placeholder = 'Search', className, size = 'md', ...rest }: SearchFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <Input
      ref={inputRef}
      type="search"
      icon={Search}
      size={size}
      value={value}
      placeholder={placeholder}
      aria-label={rest['aria-label'] ?? placeholder}
      autoFocus={rest.autoFocus}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && value) {
          event.stopPropagation()
          onChange('')
        }
      }}
      wrapperClassName={className ?? 'w-full'}
      className="[&::-webkit-search-cancel-button]:hidden"
      trailing={
        value ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              onChange('')
              inputRef.current?.focus()
            }}
            className="-mr-1 grid size-5 place-items-center rounded-xs text-fg-subtle hover:bg-neutral-soft hover:text-fg focus-ring"
          >
            <X size={12} strokeWidth={2} />
          </button>
        ) : null
      }
    />
  )
}
