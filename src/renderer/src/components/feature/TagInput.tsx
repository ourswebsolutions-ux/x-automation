import { Tag, X } from 'lucide-react'
import { useState, type KeyboardEvent } from 'react'
import { fieldSurface } from '@/components/ui/Input'
import { cn } from '@/lib/cn'

interface TagInputProps {
  value: string[]
  onChange: (tags: string[]) => void
  id?: string
  disabled?: boolean
  placeholder?: string
  max?: number
  /** Existing tags offered as suggestions. */
  suggestions?: string[]
}

/**
 * Free-form label chips (e.g. "launch", "partner"). Enter or comma adds a tag;
 * Backspace on an empty field removes the last one.
 */
export function TagInput({ value, onChange, id, disabled, placeholder = 'Add tag', max = 10, suggestions = [] }: TagInputProps) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  const add = (raw: string) => {
    const next = [...value]
    for (const part of raw.split(',').map((p) => p.trim().replace(/\s+/g, ' ')).filter(Boolean)) {
      if (part.length > 30) {
        setError('Tags can be up to 30 characters.')
        return
      }
      if (next.some((t) => t.toLowerCase() === part.toLowerCase())) continue
      if (next.length >= max) {
        setError(`Up to ${max} tags.`)
        break
      }
      next.push(part)
    }
    onChange(next)
    setText('')
    setError(null)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if ((event.key === 'Enter' || event.key === ',') && text.trim()) {
      event.preventDefault()
      add(text)
    } else if (event.key === 'Backspace' && !text && value.length) {
      onChange(value.slice(0, -1))
    }
  }

  const offered = text.trim() ? suggestions.filter((s) => s.toLowerCase().startsWith(text.trim().toLowerCase()) && !value.some((v) => v.toLowerCase() === s.toLowerCase())).slice(0, 5) : []

  return (
    <div className="flex flex-col gap-1">
      <div className={cn(fieldSurface, 'flex min-h-8 flex-wrap items-center gap-1 border-line-strong px-1.5 py-1', error && 'border-danger/60', disabled && 'opacity-60')}>
        <Tag size={13} className="ml-1 shrink-0 text-fg-subtle" aria-hidden />
        {value.map((tag) => (
          <span key={tag} className="inline-flex h-6 items-center gap-1 rounded-sm bg-surface-4 pl-2 pr-1 text-xs text-fg-muted">
            {tag}
            <button
              type="button"
              disabled={disabled}
              aria-label={`Remove tag ${tag}`}
              onClick={() => onChange(value.filter((t) => t !== tag))}
              className="grid size-4 place-items-center rounded-xs hover:bg-surface-3 focus-ring"
            >
              <X size={10} strokeWidth={2.5} />
            </button>
          </span>
        ))}
        <input
          id={id}
          value={text}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          placeholder={value.length ? '' : placeholder}
          aria-label="Add tag"
          onChange={(e) => {
            setText(e.target.value)
            setError(null)
          }}
          onKeyDown={onKeyDown}
          onBlur={() => text.trim() && add(text)}
          className="h-6 min-w-24 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-fg-faint"
        />
      </div>
      {offered.length > 0 && (
        <div className="flex flex-wrap gap-1" aria-label="Suggested tags">
          {offered.map((s) => (
            <button key={s} type="button" onMouseDown={(e) => (e.preventDefault(), add(s))} className="rounded-sm border border-line px-1.5 py-0.5 text-2xs text-fg-subtle hover:bg-surface-3">
              {s}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
