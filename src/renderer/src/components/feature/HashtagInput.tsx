import { Hash, X } from 'lucide-react'
import { useState, type KeyboardEvent } from 'react'
import { MAX_HASHTAGS, normalizeHashtag } from '@shared/config/postLimits'
import { fieldSurface } from '@/components/ui/Input'
import { cn } from '@/lib/cn'

interface HashtagInputProps {
  value: string[]
  onChange: (tags: string[]) => void
  id?: string
  disabled?: boolean
  placeholder?: string
  max?: number
}

/**
 * Hashtag chips. Type a tag and press Enter, Space or comma; Backspace on an
 * empty field removes the last one. Tags are stored without "#".
 */
export function HashtagInput({ value, onChange, id, disabled, placeholder = 'Add hashtag', max = MAX_HASHTAGS }: HashtagInputProps) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  const add = (raw: string) => {
    const parts = raw.split(/[\s,]+/).filter(Boolean)
    if (!parts.length) return
    const next = [...value]
    for (const part of parts) {
      const tag = normalizeHashtag(part)
      if (!tag) {
        setError(`“${part.slice(0, 30)}” isn’t a valid hashtag — letters, numbers and _ only.`)
        return
      }
      if (next.some((t) => t.toLowerCase() === tag.toLowerCase())) continue
      if (next.length >= max) {
        setError(`Up to ${max} hashtags.`)
        break
      }
      next.push(tag)
    }
    onChange(next)
    setText('')
    setError(null)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if ((event.key === 'Enter' || event.key === ',' || event.key === ' ') && text.trim()) {
      event.preventDefault()
      add(text)
    } else if (event.key === 'Backspace' && !text && value.length) {
      onChange(value.slice(0, -1))
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className={cn(fieldSurface, 'flex min-h-8 flex-wrap items-center gap-1 border-line-strong px-1.5 py-1', error && 'border-danger/60')}>
        <Hash size={13} className="ml-1 shrink-0 text-fg-subtle" aria-hidden />
        {value.map((tag) => (
          <span key={tag} className="inline-flex h-6 items-center gap-1 rounded-sm bg-accent-soft pl-2 pr-1 text-xs text-accent-text">
            #{tag}
            <button
              type="button"
              disabled={disabled}
              aria-label={`Remove #${tag}`}
              onClick={() => onChange(value.filter((t) => t !== tag))}
              className="grid size-4 place-items-center rounded-xs hover:bg-accent-soft focus-ring"
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
          aria-label="Add hashtag"
          onChange={(e) => {
            setText(e.target.value)
            setError(null)
          }}
          onKeyDown={onKeyDown}
          onBlur={() => text.trim() && add(text)}
          className="h-6 min-w-24 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-fg-faint"
        />
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
