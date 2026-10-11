import { isLikelyImageModel } from '@shared/config/imageModels'
import { Check, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { AiModelList } from '@shared/types/ai'
import { Button, Checkbox, Input, Tooltip } from '@/components/ui'
import { errorMessage, relay } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { formatRelative } from '@/lib/format'

interface ModelPickerProps {
  id?: string
  /** Saved configuration whose model list can be fetched; null while creating. */
  providerId: string | null
  /** False until the configuration is saved with whatever key it needs. */
  canFetch: boolean
  value: string
  onChange: (model: string) => void
  invalid?: boolean
  /** Which models to list first: text models (default) or image models. */
  kind?: 'text' | 'image'
}

/**
 * Model id input plus the provider's own model list. Nothing is hard-coded:
 * the list comes from GET /models, and any id can be typed for servers whose
 * list is incomplete.
 */
export function ModelPicker({ id, providerId, canFetch, value, onChange, invalid, kind = 'text' }: ModelPickerProps) {
  const relevant = (m: { id: string; likelyText: boolean }) => (kind === 'image' ? isLikelyImageModel(m.id) : m.likelyText)
  const [list, setList] = useState<AiModelList | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    setList(null)
    setError(null)
    if (!providerId) return
    let live = true
    relay.ai.listModels(providerId, false).then((cached) => live && setList(cached), () => undefined)
    return () => {
      live = false
    }
  }, [providerId])

  const refresh = async () => {
    if (!providerId) return
    setLoading(true)
    setError(null)
    try {
      setList(await relay.ai.listModels(providerId, true))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }

  const visible = useMemo(() => {
    const q = value.trim().toLowerCase()
    const models = (list?.models ?? []).filter((m) => showAll || relevant(m))
    const exact = models.some((m) => m.id.toLowerCase() === q)
    return exact ? models : models.filter((m) => !q || m.id.toLowerCase().includes(q))
  }, [list, value, showAll, kind])
  const hidden = (list?.models.length ?? 0) - (list?.models.filter(relevant).length ?? 0)
  const listed = list ? list.models.some((m) => m.id === value.trim()) : null

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Input
          id={id}
          value={value}
          spellCheck={false}
          autoComplete="off"
          placeholder={list ? 'Choose below or type a model id' : 'Type a model id, or fetch the list'}
          invalid={invalid}
          onChange={(e) => onChange(e.target.value)}
          wrapperClassName="flex-1"
          className="font-mono text-xs"
        />
        <Tooltip content={canFetch ? 'Fetch the models this key can use (free GET /models)' : 'Save the configuration with its key first'}>
          <Button icon={RefreshCw} loading={loading} disabled={!canFetch} onClick={refresh} className={loading ? '' : undefined}>
            {list ? 'Refresh' : 'Fetch models'}
          </Button>
        </Tooltip>
      </div>

      {error && <p className="text-xs text-danger">{error}</p>}

      {list && (
        <div className="overflow-hidden rounded-md border border-line-strong bg-surface-1">
          <div role="listbox" aria-label="Available models" className="max-h-44 overflow-y-auto p-1">
            {visible.map((m) => (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={m.id === value.trim()}
                onClick={() => onChange(m.id)}
                className={cn(
                  'flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left font-mono text-xs outline-none transition-colors',
                  'hover:bg-neutral-soft focus-visible:bg-neutral-soft focus-visible:shadow-[inset_0_0_0_1px_var(--accent-line)]',
                  m.id === value.trim() ? 'bg-accent-soft text-accent-text' : 'text-fg-muted',
                  !relevant(m) && 'text-fg-subtle'
                )}
              >
                <span className="min-w-0 flex-1 truncate">{m.id}</span>
                {!relevant(m) && <span className="font-sans text-2xs text-fg-faint">{kind === 'image' ? 'not an image model' : 'not text'}</span>}
                {m.id === value.trim() && <Check size={12} strokeWidth={2.5} />}
              </button>
            ))}
            {visible.length === 0 && <p className="px-2 py-2 text-xs text-fg-subtle">No listed model matches — the id you typed will be used as is.</p>}
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-line px-2.5 py-1.5 text-2xs text-fg-faint">
            <span>
              {list.models.length} models listed by the provider · fetched {formatRelative(list.fetchedAt)}
            </span>
            {hidden > 0 && (
              <label className="flex cursor-pointer items-center gap-1.5">
                <Checkbox checked={showAll} onChange={setShowAll} aria-label={kind === 'image' ? 'Show other models' : 'Show non-text models'} />
                Show {hidden} {kind === 'image' ? 'other' : 'non-text'}
              </label>
            )}
          </div>
        </div>
      )}
      {!list && (
        <p className="text-xs text-fg-subtle">
          {canFetch ? 'Fetch the list to choose from the models this key can use.' : 'After saving, you can fetch the models this key can use.'} Models are never
          assumed — any id the provider accepts works.
        </p>
      )}
      {list && value.trim() && listed === false && (
        <p className="text-xs text-warning">“{value.trim()}” is not in this provider’s list. It will be tried as typed; some compatible servers list only part of their models.</p>
      )}
    </div>
  )
}
