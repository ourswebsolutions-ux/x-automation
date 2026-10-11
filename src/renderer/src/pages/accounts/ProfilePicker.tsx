import { Check, Globe } from 'lucide-react'
import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Account } from '@shared/types/accounts'
import type { BrowserProfile } from '@shared/types/ixbrowser'
import { SearchField, StatusDot } from '@/components/ui'
import { cn } from '@/lib/cn'

interface ProfilePickerProps {
  profiles: BrowserProfile[]
  accounts: Account[]
  value: string | null
  onChange: (profileId: string | null) => void
  /** The account being edited — its own profile is not "taken". */
  selfId?: string
  /** Offer a "no profile" choice at the top. */
  allowNone?: boolean
  id?: string
}

/**
 * Searchable single-choice list of synchronised profiles. Only profiles IX
 * Browser reported in the last sync can be chosen; profiles another account
 * already uses are shown but disabled, so duplicates are impossible.
 */
export function ProfilePicker({ profiles, accounts, value, onChange, selfId, allowNone = false, id }: ProfilePickerProps) {
  const [query, setQuery] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  const owners = useMemo(() => {
    const map = new Map<string, Account>()
    for (const account of accounts) if (account.profile && account.id !== selfId) map.set(account.profile.id, account)
    return map
  }, [accounts, selfId])

  const options = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^#/, '')
    return profiles
      .filter((p) => p.availability === 'available')
      .filter((p) => !q || p.name.toLowerCase().includes(q) || String(p.externalId).includes(q))
      .sort((a, b) => Number(owners.has(a.id)) - Number(owners.has(b.id)) || a.name.localeCompare(b.name))
  }, [profiles, owners, query])

  const free = options.filter((p) => !owners.has(p.id)).length
  const choices: (string | null)[] = [...(allowNone ? [null] : []), ...options.filter((p) => !owners.has(p.id)).map((p) => p.id)]

  const onKeyDown = (event: KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const index = choices.indexOf(value)
    const next =
      event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : Math.min(Math.max(index + (event.key === 'ArrowDown' ? 1 : -1), 0), choices.length - 1)
    const target = choices[next]
    if (target === undefined) return
    onChange(target)
    listRef.current?.querySelector<HTMLElement>(`[data-value="${target ?? 'none'}"]`)?.focus()
  }

  const available = profiles.filter((p) => p.availability === 'available').length

  return (
    <div className="flex flex-col gap-2">
      <SearchField value={query} onChange={setQuery} placeholder="Search by name or profile ID" size="sm" aria-label="Search profiles" />
      <div
        ref={listRef}
        id={id}
        role="radiogroup"
        aria-label="Browser profile"
        onKeyDown={onKeyDown}
        className="max-h-[232px] overflow-y-auto rounded-md border border-line-strong bg-surface-1 p-1"
      >
        {allowNone && (
          <Option value={null} selected={value === null} focusable={value === null || !choices.includes(value)} onSelect={() => onChange(null)}>
            <span className="text-fg-muted">No profile for now</span>
          </Option>
        )}
        {options.map((p) => {
          const owner = owners.get(p.id)
          return (
            <Option
              key={p.id}
              value={p.id}
              selected={value === p.id}
              focusable={value === p.id || (!allowNone && value === null && choices[0] === p.id)}
              disabled={Boolean(owner)}
              onSelect={() => onChange(p.id)}
            >
              <span className={cn('min-w-0 flex-1 truncate', owner ? 'text-fg-subtle' : 'text-fg')}>{p.name}</span>
              {owner ? (
                <span className="shrink-0 truncate text-2xs text-fg-subtle">Linked to {owner.label}</span>
              ) : (
                p.runState === 'running' && (
                  <span className="flex shrink-0 items-center gap-1 text-2xs text-fg-subtle">
                    <StatusDot tone="success" /> Running
                  </span>
                )
              )}
              <span className="tabular shrink-0 font-mono text-2xs text-fg-faint">#{p.externalId}</span>
            </Option>
          )
        })}
        {options.length === 0 && (
          <p className="flex items-center gap-2 px-2.5 py-3 text-xs text-fg-subtle">
            <Globe size={13} />
            {available === 0 ? 'No synchronised profiles. Sync IX Browser profiles first.' : 'No profiles match.'}
          </p>
        )}
      </div>
      <p className="text-2xs text-fg-faint">
        {free} of {available} available profile{available === 1 ? '' : 's'} can be linked. Profiles missing from the last sync are hidden.
      </p>
    </div>
  )
}

function Option(props: {
  value: string | null
  selected: boolean
  focusable: boolean
  disabled?: boolean
  onSelect: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.selected}
      aria-disabled={props.disabled || undefined}
      data-value={props.value ?? 'none'}
      tabIndex={props.focusable && !props.disabled ? 0 : -1}
      onClick={() => !props.disabled && props.onSelect()}
      className={cn(
        'flex h-8 w-full items-center gap-2.5 rounded-sm px-2 text-left text-sm outline-none transition-colors',
        'focus-visible:bg-neutral-soft focus-visible:shadow-[inset_0_0_0_1px_var(--accent-line)]',
        props.disabled ? 'cursor-not-allowed' : 'hover:bg-neutral-soft',
        props.selected && 'bg-accent-soft hover:bg-accent-soft'
      )}
    >
      <span
        aria-hidden
        className={cn(
          'grid size-3.5 shrink-0 place-items-center rounded-full border',
          props.selected ? 'border-accent bg-accent text-accent-fg' : 'border-line-heavy',
          props.disabled && 'opacity-40'
        )}
      >
        {props.selected && <Check size={9} strokeWidth={3.5} />}
      </span>
      {props.children}
    </button>
  )
}
