import { Check, ChevronsUpDown, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { cn } from '@/lib/cn'
import { fieldSurface } from './Input'
import { Popover } from './Popover'

export interface SelectOption<V extends string = string> {
  value: V
  label: string
  description?: string
  icon?: LucideIcon
  disabled?: boolean
}

interface SelectProps<V extends string> {
  value: V | null
  onChange: (value: V) => void
  options: SelectOption<V>[]
  placeholder?: string
  disabled?: boolean
  size?: 'sm' | 'md'
  id?: string
  className?: string
  'aria-label'?: string
}

/** Accessible listbox select with keyboard navigation and typeahead. */
export function Select<V extends string>({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  disabled,
  size = 'md',
  id,
  className,
  ...aria
}: SelectProps<V>) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const selected = options.find((option) => option.value === value)

  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return
    setActive(Math.max(0, options.findIndex((option) => option.value === value)))
    requestAnimationFrame(() => listRef.current?.focus())
  }, [open, options, value])

  useEffect(() => {
    if (open) listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const move = (delta: number) => {
    if (!options.length) return
    let next = active
    for (let i = 0; i < options.length; i++) {
      next = (next + delta + options.length) % options.length
      if (!options[next]?.disabled) break
    }
    setActive(next)
  }

  const commit = (index: number) => {
    const option = options[index]
    if (!option || option.disabled) return
    onChange(option.value)
    setOpen(false)
    triggerRef.current?.focus()
  }

  const onListKeyDown = (event: KeyboardEvent) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        move(1)
        break
      case 'ArrowUp':
        event.preventDefault()
        move(-1)
        break
      case 'Home':
        event.preventDefault()
        setActive(0)
        break
      case 'End':
        event.preventDefault()
        setActive(options.length - 1)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        commit(active)
        break
      case 'Tab':
        setOpen(false)
        break
      default:
        if (event.key.length === 1) {
          const index = options.findIndex((option) => option.label.toLowerCase().startsWith(event.key.toLowerCase()))
          if (index >= 0) setActive(index)
        }
    }
  }

  const SelectedIcon = selected?.icon

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={aria['aria-label']}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
          }
        }}
        className={cn(
          fieldSurface,
          'inline-flex items-center gap-2 border-line-strong pl-2.5 pr-2 text-left text-sm focus-ring',
          'disabled:pointer-events-none disabled:opacity-50',
          open && 'border-accent-line shadow-[0_0_0_3px_var(--accent-soft)]',
          size === 'sm' ? 'h-7 text-xs' : 'h-8',
          className
        )}
      >
        {SelectedIcon && <SelectedIcon size={14} strokeWidth={1.8} className="shrink-0 text-fg-subtle" />}
        <span className={cn('min-w-0 flex-1 truncate', !selected && 'text-fg-faint')}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronsUpDown size={13} strokeWidth={1.8} className="shrink-0 text-fg-subtle" aria-hidden />
      </button>

      <Popover open={open} onClose={close} anchorRef={triggerRef} matchWidth className="p-1">
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-activedescendant={`${listId}-${active}`}
          onKeyDown={onListKeyDown}
          className="max-h-72 overflow-y-auto outline-none"
        >
          {options.map((option, index) => {
            const isSelected = option.value === value
            const Icon = option.icon
            return (
              <div
                key={option.value}
                id={`${listId}-${index}`}
                data-index={index}
                role="option"
                aria-selected={isSelected}
                aria-disabled={option.disabled || undefined}
                onPointerMove={() => !option.disabled && setActive(index)}
                onClick={() => commit(index)}
                className={cn(
                  'flex items-start gap-2 rounded-sm px-2 py-1.5 text-sm',
                  index === active && !option.disabled && 'bg-neutral-soft',
                  option.disabled ? 'opacity-40' : 'text-fg'
                )}
              >
                {Icon && <Icon size={14} strokeWidth={1.8} className="mt-0.5 shrink-0 text-fg-subtle" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{option.label}</span>
                  {option.description && <span className="block text-xs text-fg-subtle">{option.description}</span>}
                </span>
                <Check
                  size={14}
                  strokeWidth={2}
                  className={cn('mt-0.5 shrink-0 text-accent', isSelected ? 'opacity-100' : 'opacity-0')}
                  aria-hidden
                />
              </div>
            )
          })}
        </div>
      </Popover>
    </>
  )
}
