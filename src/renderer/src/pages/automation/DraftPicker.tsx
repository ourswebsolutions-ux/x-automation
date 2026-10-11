import { ImageIcon } from 'lucide-react'
import { useState } from 'react'
import type { Id } from '@shared/types/domain'
import { Button, Checkbox, SearchField } from '@/components/ui'
import { useDrafts } from '@/data/drafts'

interface Props {
  value: Id[]
  onChange: (ids: Id[]) => void
}

/** Your own drafts for a run, in the order they were picked. Scheduled and published drafts can't be used. */
export function DraftPicker({ value, onChange }: Props) {
  const drafts = useDrafts()
  const [query, setQuery] = useState('')
  const usable = (drafts.data ?? []).filter((d) => d.status === 'draft' || d.status === 'ready')
  const shown = usable.filter((d) => !query.trim() || d.body.toLowerCase().includes(query.trim().toLowerCase()))
  const missing = value.filter((id) => !usable.some((d) => d.id === id)).length
  const toggle = (id: Id, on: boolean) => onChange(on ? [...value.filter((x) => x !== id), id] : value.filter((x) => x !== id))

  return (
    <div className="flex flex-col gap-2 rounded-md border border-line">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <SearchField value={query} onChange={setQuery} placeholder="Search your drafts" size="sm" className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => onChange([...value, ...shown.map((d) => d.id).filter((id) => !value.includes(id))])}>
          Select all
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onChange([])}>
          Clear
        </Button>
      </div>
      {usable.length === 0 ? (
        <p className="px-3 pb-3 text-xs text-fg-subtle">You have no unscheduled drafts. Write some in Posts &amp; Drafts first.</p>
      ) : (
        <ul className="max-h-64 overflow-y-auto" aria-label="Your drafts">
          {shown.map((d) => {
            const order = value.indexOf(d.id)
            return (
              <li key={d.id} className="flex items-start gap-3 px-3 py-2 hover:bg-surface-3">
                <Checkbox checked={order >= 0} onChange={(on) => toggle(d.id, on)} aria-label={`Use draft: ${d.body.slice(0, 100)}`} />
                <span className="line-clamp-2 min-w-0 flex-1 text-sm text-fg">{d.body || <span className="text-fg-faint">Image only</span>}</span>
                {d.media.length > 0 && <ImageIcon size={13} className="mt-1 shrink-0 text-fg-subtle" aria-label="Has an image" />}
                {order >= 0 && <span className="tabular w-6 shrink-0 text-right text-xs text-accent-text">{order + 1}</span>}
              </li>
            )
          })}
        </ul>
      )}
      <p className="px-3 pb-2 text-xs text-fg-subtle" aria-live="polite">
        {value.length} {value.length === 1 ? 'draft' : 'drafts'} selected · used in this order, text unchanged
        {missing > 0 ? ` · ${missing} no longer available` : ''}
      </p>
    </div>
  )
}
