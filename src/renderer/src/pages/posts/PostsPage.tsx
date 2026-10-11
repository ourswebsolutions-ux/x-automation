import { Bot, Copy, FileText, HardDrive, Image as ImageIcon, Images, Sparkles, SquarePen, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useBlocker, useNavigate, useSearchParams } from 'react-router'
import { composePost } from '@shared/config/postLimits'
import type { Draft, DraftStatus } from '@shared/types/domain'
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  IconButton,
  PageHeader,
  Panel,
  SearchField,
  Select,
  SkeletonRows,
  StatusBadge,
  Tabs,
  Tooltip,
  useToast
} from '@/components/ui'
import { useAccounts } from '@/data/accounts'
import { useDrafts } from '@/data/drafts'
import { MOD_LABEL } from '@/hooks/useHotkey'
import { errorMessage, relay } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { formatDateTime, formatRelative } from '@/lib/format'
import { measurePost } from '@/lib/postLength'
import { usePreferences } from '@/state/preferences'
import { useNotifications } from '@/state/notifications'
import { NAV_ITEMS } from '@/app/navigation'
import { DraftEditor, type EditorValue } from './DraftEditor'
import { AssetLibraryDialog } from '@/components/feature/AssetLibraryDialog'

type StatusFilter = 'all' | DraftStatus
type Sort = 'updated-desc' | 'updated-asc' | 'created-desc' | 'created-asc'

/** Editor state → save payload: attachments are sent as ordered asset ids with descriptions. */
const toInput = ({ media, ...value }: EditorValue) => ({ ...value, attachments: media.map((m) => ({ assetId: m.id, altText: m.altText })) })

const STATUS_LABEL: Record<DraftStatus, string> = { draft: 'Draft', ready: 'Ready', scheduled: 'Scheduled', published: 'Published', failed: 'Failed' }

export function PostsPage() {
  const toast = useToast()
  const navigate = useNavigate()
  const { push } = useNotifications()
  const { preferences } = usePreferences()
  const [params, setParams] = useSearchParams()
  const drafts = useDrafts()
  const accounts = useAccounts()
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [sort, setSort] = useState<Sort>('updated-desc')
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<Draft | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [pendingSwitch, setPendingSwitch] = useState<(() => void) | null>(null)
  const [libraryOpen, setLibraryOpen] = useState(false)

  const list = drafts.data ?? []
  const composing = params.get('compose') === '1'
  const selectedId = params.get('draft')
  const selected = selectedId ? (list.find((d) => d.id === selectedId) ?? null) : null
  const editorOpen = composing || Boolean(selected)

  // A stale ?draft= link (e.g. a deleted draft) falls back to the list.
  useEffect(() => {
    if (selectedId && drafts.status === 'success' && !selected) setParams({}, { replace: true })
  }, [selectedId, selected, drafts.status, setParams])

  // Leaving the window with unsaved edits asks first (LeaveGuard covers in-app navigation).
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  /** Runs `action` now, or after confirming that unsaved edits may be discarded. */
  const guard = (action: () => void) => {
    if (dirty && preferences.confirmations.discardChanges) setPendingSwitch(() => action)
    else action()
  }
  const open = (draft: Draft | null) => guard(() => setParams(draft ? { draft: draft.id } : { compose: '1' }))

  const counts = useMemo(() => {
    const c: Partial<Record<DraftStatus, number>> = {}
    for (const d of list) c[d.status] = (c[d.status] ?? 0) + 1
    return c
  }, [list])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const [field, direction] = sort.split('-') as ['updated' | 'created', 'asc' | 'desc']
    return list
      .filter((d) => (status === 'all' || d.status === status) && (!q || `${d.body} ${d.hashtags.map((t) => `#${t}`).join(' ')}`.toLowerCase().includes(q)))
      .sort((a, b) => {
        const av = field === 'updated' ? a.updatedAt : a.createdAt
        const bv = field === 'updated' ? b.updatedAt : b.createdAt
        return direction === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      })
  }, [list, query, status, sort])

  const upsertLocal = (draft: Draft) => drafts.setData([draft, ...list.filter((d) => d.id !== draft.id)])

  const save = async (value: EditorValue) => {
    setSaving(true)
    try {
      const saved = await relay.drafts.save({ id: selected?.id, ...toInput(value) })
      upsertLocal(saved)
      setDirty(false)
      toast({ tone: 'success', title: selected ? 'Draft saved' : 'Draft created' })
      if (!selected) setParams({ draft: saved.id }, { replace: true })
    } catch (error) {
      toast({ tone: 'danger', title: 'Draft not saved', description: errorMessage(error), duration: 8000 })
    } finally {
      setSaving(false)
    }
  }

  const saveAsNew = async (value: EditorValue) => {
    try {
      const created = await relay.drafts.save(toInput(value))
      drafts.setData([created, ...(drafts.data ?? [])])
      toast({ tone: 'success', title: 'Saved as a new draft', description: 'The draft you are editing was not changed.' })
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not save', description: errorMessage(error) })
    }
  }

  const duplicate = async (draft: Draft) => {
    try {
      const copy = await relay.drafts.duplicate(draft.id)
      drafts.setData([copy, ...list])
      toast({ tone: 'success', title: 'Draft duplicated', action: { label: 'Open copy', onClick: () => open(copy) } })
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not duplicate', description: errorMessage(error) })
    }
  }

  const deleteDraft = async (draft: Draft) => {
    setDeleting(true)
    try {
      await relay.drafts.remove(draft.id)
      drafts.setData(list.filter((d) => d.id !== draft.id))
      if (selected?.id === draft.id) {
        setDirty(false)
        setParams({}, { replace: true })
      }
      push({ tone: 'warning', title: 'Draft deleted', body: draft.body.slice(0, 80), to: NAV_ITEMS.posts.path })
      setPendingDelete(null)
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not delete draft', description: errorMessage(error) })
    } finally {
      setDeleting(false)
    }
  }
  const requestDelete = (draft: Draft) => (preferences.confirmations.deleteDraft ? setPendingDelete(draft) : void deleteDraft(draft))
  const onDirtyChange = useCallback((next: boolean) => setDirty(next), [])

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={NAV_ITEMS.posts.label}
        description={NAV_ITEMS.posts.description}
        meta={
          <Tooltip content="Stored in the local SQLite database on this device">
            <StatusBadge tone="neutral" icon={HardDrive}>
              Saved locally
            </StatusBadge>
          </Tooltip>
        }
        actions={
          <>
            <Button variant="ghost" icon={Images} onClick={() => setLibraryOpen(true)}>
              Image library
            </Button>
            <Button icon={Sparkles} onClick={() => guard(() => navigate(NAV_ITEMS.generator.path))}>
              Generate with AI
            </Button>
            <Button variant="primary" icon={SquarePen} onClick={() => open(null)} title={`New draft (${MOD_LABEL}+N)`}>
              New draft
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 @5xl:grid-cols-[360px_minmax(0,1fr)]">
        <Panel
          title="Drafts"
          meta={<span className="tabular text-xs text-fg-subtle">{drafts.data ? list.length : ''}</span>}
          padded={false}
          className="@5xl:sticky @5xl:top-4 @5xl:max-h-[calc(100vh-180px)] @5xl:self-start"
          bodyClassName="flex min-h-0 flex-col"
        >
          <div className="flex flex-col gap-2 border-b border-line px-3 pb-2 pt-2.5">
            <SearchField value={query} onChange={setQuery} placeholder="Search text or #hashtag" size="sm" aria-label="Search drafts" />
            <div className="flex items-center gap-2">
              <Tabs<StatusFilter>
                aria-label="Filter by status"
                value={status}
                onChange={setStatus}
                className="min-w-0 flex-1 border-b-0"
                items={[
                  { value: 'all', label: 'All', count: list.length },
                  { value: 'draft', label: 'Draft', count: counts.draft ?? 0 },
                  { value: 'ready', label: 'Ready', count: counts.ready ?? 0 },
                  ...(['scheduled', 'published', 'failed'] as const).filter((s) => counts[s]).map((s) => ({ value: s, label: STATUS_LABEL[s], count: counts[s] }))
                ]}
              />
            </div>
            <Select<Sort>
              size="sm"
              aria-label="Sort drafts"
              value={sort}
              onChange={setSort}
              options={[
                { value: 'updated-desc', label: 'Last modified · newest' },
                { value: 'updated-asc', label: 'Last modified · oldest' },
                { value: 'created-desc', label: 'Created · newest' },
                { value: 'created-asc', label: 'Created · oldest' }
              ]}
            />
          </div>
          {drafts.status === 'error' ? (
            <ErrorState size="sm" title="Drafts could not be loaded" error={drafts.error} onRetry={drafts.reload} />
          ) : !drafts.data ? (
            <SkeletonRows rows={4} className="p-4" />
          ) : list.length === 0 ? (
            <EmptyState
              size="sm"
              icon={FileText}
              title="No drafts yet"
              description="Write one by hand — no AI provider needed — or generate variations with AI."
              actions={
                <Button size="sm" variant="primary" icon={SquarePen} onClick={() => open(null)}>
                  New draft
                </Button>
              }
            />
          ) : rows.length === 0 ? (
            <EmptyState size="sm" icon={FileText} title="No drafts match" description="Try another search or filter." />
          ) : (
            <ul aria-label="Drafts" className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
              {rows.map((draft) => (
                <DraftItem
                  key={draft.id}
                  draft={draft}
                  active={draft.id === selected?.id}
                  maxWeighted={preferences.editor.lengthProfile === 'premium' ? 25_000 : 280}
                  accountLabel={accounts.data?.find((a) => a.id === draft.accountId)?.label ?? null}
                  onOpen={() => draft.id !== selected?.id && open(draft)}
                  onDuplicate={() => duplicate(draft)}
                  onDelete={() => requestDelete(draft)}
                />
              ))}
            </ul>
          )}
        </Panel>

        {editorOpen ? (
          <DraftEditor
            draft={selected}
            accounts={accounts.data ?? []}
            saving={saving}
            onSave={save}
            onSaveAsNew={saveAsNew}
            onDuplicate={() => selected && duplicate(selected)}
            onDelete={() => selected && requestDelete(selected)}
            onDirtyChange={onDirtyChange}
          />
        ) : (
          <Panel>
            <EmptyState
              icon={SquarePen}
              title="Select a draft or start a new one"
              description="Drafts are saved on this device. AI tools are optional — everything here works without a provider."
              actions={
                <>
                  <Button variant="primary" icon={SquarePen} onClick={() => open(null)}>
                    New draft
                  </Button>
                  <Button icon={Sparkles} onClick={() => navigate(NAV_ITEMS.generator.path)}>
                    Generate with AI
                  </Button>
                </>
              }
            />
          </Panel>
        )}
      </div>

      <AssetLibraryDialog open={libraryOpen} onClose={() => setLibraryOpen(false)} />
      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="Delete this draft?"
        description="It is removed from this device and can’t be undone. Its generation history stays."
        confirmLabel="Delete draft"
        tone="danger"
        busy={deleting}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => pendingDelete && deleteDraft(pendingDelete)}
      />
      {dirty && preferences.confirmations.discardChanges && <LeaveGuard onLeave={() => setDirty(false)} />}
      <ConfirmDialog
        open={Boolean(pendingSwitch)}
        title="Discard unsaved changes?"
        description="Your edits to this draft haven’t been saved."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        tone="danger"
        onCancel={() => setPendingSwitch(null)}
        onConfirm={() => {
          setDirty(false)
          const action = pendingSwitch
          setPendingSwitch(null)
          action?.()
        }}
      />
    </div>
  )
}

/**
 * Blocks leaving the Posts page while there are unsaved edits. Mounted only
 * while the editor is dirty, so no blocker exists during ordinary navigation.
 */
function LeaveGuard({ onLeave }: { onLeave: () => void }) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => currentLocation.pathname !== nextLocation.pathname)
  return (
    <ConfirmDialog
      open={blocker.state === 'blocked'}
      title="Discard unsaved changes?"
      description="Your edits to this draft haven’t been saved."
      confirmLabel="Discard changes"
      cancelLabel="Keep editing"
      tone="danger"
      onCancel={() => blocker.reset?.()}
      onConfirm={() => {
        onLeave()
        blocker.proceed?.()
      }}
    />
  )
}

function DraftItem(props: {
  draft: Draft
  active: boolean
  maxWeighted: number
  accountLabel: string | null
  onOpen: () => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const { draft: d } = props
  const text = composePost(d.body, d.hashtags)
  const length = measurePost(text, props.maxWeighted)
  return (
    <li className={cn('group relative transition-colors hover:bg-highlight', props.active && 'bg-highlight shadow-[inset_2px_0_0_var(--accent)]')}>
      <button type="button" onClick={props.onOpen} aria-current={props.active || undefined} className="flex w-full flex-col gap-1.5 px-3.5 py-3 pr-16 text-left outline-none focus-visible:bg-highlight">
        <p className={cn('line-clamp-2 text-sm text-pretty', text.trim() ? 'text-fg' : 'text-fg-faint')}>{text.trim() || (d.media.length ? 'Image-only post' : 'Empty draft')}</p>
        <span className="flex flex-wrap items-center gap-1.5 text-2xs text-fg-subtle">
          <StatusBadge tone={d.status === 'ready' ? 'success' : 'neutral'}>{STATUS_LABEL[d.status]}</StatusBadge>
          {d.origin === 'ai' ? (
            <StatusBadge tone="accent" icon={Bot}>
              AI-assisted
            </StatusBadge>
          ) : (
            <StatusBadge variant="outline">Manual</StatusBadge>
          )}
          <span title={`Modified ${formatDateTime(d.updatedAt)} · created ${formatDateTime(d.createdAt)}`}>{formatRelative(d.updatedAt)}</span>
          <span aria-hidden>·</span>
          <span className={cn('tabular', length.isOver && 'text-danger')}>{length.weighted}</span>
          {d.media.length > 0 && (
            <span className="flex items-center gap-0.5" title={`${d.media.length} image${d.media.length === 1 ? '' : 's'}`}>
              <ImageIcon size={11} /> {d.media.length}
            </span>
          )}
          {props.accountLabel && (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{props.accountLabel}</span>
            </>
          )}
        </span>
      </button>
      <span className="absolute right-2 top-2.5 flex opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <IconButton icon={Copy} label="Duplicate draft" size="sm" onClick={props.onDuplicate} />
        <IconButton icon={Trash2} label="Delete draft" size="sm" onClick={props.onDelete} />
      </span>
    </li>
  )
}
