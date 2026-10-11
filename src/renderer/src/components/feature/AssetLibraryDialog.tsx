import { Check, FolderOpen, ImagePlus, Images, Sparkles, Trash2, Upload } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { attachmentProblem, IMAGE_TYPES } from '@shared/config/mediaLimits'
import type { AssetOrigin, AssetQuery, ImageAsset, ImportResult } from '@shared/types/images'
import { Button, ConfirmDialog, EmptyState, ErrorState, Modal, SearchField, SegmentedControl, Select, SkeletonRows, StatusBadge, useToast } from '@/components/ui'
import { useAssets } from '@/data/assets'
import { errorMessage, relay } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { formatBytes, formatDateTime } from '@/lib/format'
import { AssetThumb } from './AssetThumb'

interface AssetLibraryDialogProps {
  open: boolean
  onClose: () => void
  /** When set, the dialog picks images: confirming calls this with the chosen ones. */
  onPick?: (assets: ImageAsset[]) => void
  /** How many may be picked (attachment slots left). */
  maxPick?: number
  pickLabel?: string
}

/** Summarises an import for a toast. */
export function importSummary(result: ImportResult): { title: string; description?: string; tone: 'success' | 'warning' | 'info' } {
  const added = result.imported.length + result.existing.length
  const rejected = result.rejected.map((r) => `${r.name}: ${r.reason}`).slice(0, 2).join(' · ')
  if (!added && result.rejected.length) return { tone: 'warning', title: 'No images added', description: rejected }
  return {
    tone: result.rejected.length ? 'warning' : 'success',
    title: `${added} image${added === 1 ? '' : 's'} ready${result.existing.length ? ` (${result.existing.length} already in the library)` : ''}`,
    description: result.rejected.length ? `Not added — ${rejected}` : undefined
  }
}

/**
 * The local image library: browse, search, sort, preview, upload, delete,
 * and (when picking) choose images to attach.
 */
export function AssetLibraryDialog({ open, onClose, onPick, maxPick = 4, pickLabel = 'Attach' }: AssetLibraryDialogProps) {
  const toast = useToast()
  const [search, setSearch] = useState('')
  const [origin, setOrigin] = useState<'all' | AssetOrigin>('all')
  const [sort, setSort] = useState<NonNullable<AssetQuery['sort']>>('newest')
  const [active, setActive] = useState<string | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [confirmDelete, setConfirmDelete] = useState<ImageAsset | null>(null)
  const [busy, setBusy] = useState(false)
  const assets = useAssets({ search, sort, ...(origin !== 'all' ? { origin } : {}) })
  const list = assets.data ?? []
  const shown = useMemo(() => list.find((a) => a.id === active) ?? list[0] ?? null, [list, active])

  useEffect(() => {
    if (open) setPicked([])
  }, [open])

  const upload = async () => {
    setBusy(true)
    try {
      const result = await relay.assets.import()
      if (result.cancelled) return
      toast(importSummary(result))
      assets.reload()
      const first = result.imported[0] ?? result.existing[0]
      if (first) setActive(first.id)
      if (onPick) setPicked((p) => [...new Set([...p, ...[...result.imported, ...result.existing].filter((a) => !attachmentProblem(a)).map((a) => a.id)])].slice(0, maxPick))
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not add images', description: errorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (asset: ImageAsset) => {
    try {
      await relay.assets.remove(asset.id)
      toast({ tone: 'success', title: 'Image deleted' })
      setConfirmDelete(null)
      assets.reload()
    } catch (error) {
      toast({ tone: 'danger', title: 'Not deleted', description: errorMessage(error), duration: 8000 })
      setConfirmDelete(null)
    }
  }

  const toggle = (asset: ImageAsset) =>
    setPicked((p) => (p.includes(asset.id) ? p.filter((id) => id !== asset.id) : maxPick === 1 ? [asset.id] : p.length >= maxPick ? p : [...p, asset.id]))

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        size="xl"
        title="Image library"
        description="Images you uploaded or generated, stored on this device. Files live in the app’s image folder; nothing is uploaded anywhere."
        footer={
          <>
            <Button variant="ghost" icon={FolderOpen} onClick={() => void relay.assets.openFolder()} className="mr-auto">
              Open folder
            </Button>
            <Button variant="ghost" onClick={onClose}>
              {onPick ? 'Cancel' : 'Close'}
            </Button>
            {onPick && (
              <Button variant="primary" icon={Check} disabled={!picked.length} onClick={() => onPick(list.filter((a) => picked.includes(a.id)).sort((a, b) => picked.indexOf(a.id) - picked.indexOf(b.id)))}>
                {pickLabel} {picked.length ? `(${picked.length})` : ''}
              </Button>
            )}
          </>
        }
      >
        <div className="@container">
        <div className="flex flex-wrap items-center gap-2 pb-3">
          <SearchField value={search} onChange={setSearch} placeholder="Search name or prompt" size="sm" className="w-60" aria-label="Search images" />
          <SegmentedControl<'all' | AssetOrigin>
            size="sm"
            value={origin}
            onChange={setOrigin}
            options={[
              { value: 'all', label: 'All' },
              { value: 'upload', label: 'Uploaded' },
              { value: 'generated', label: 'Generated' }
            ]}
          />
          <Select<NonNullable<AssetQuery['sort']>>
            size="sm"
            className="w-40"
            aria-label="Sort images"
            value={sort}
            onChange={setSort}
            options={[
              { value: 'newest', label: 'Newest first' },
              { value: 'oldest', label: 'Oldest first' },
              { value: 'largest', label: 'Largest first' },
              { value: 'name', label: 'Name' }
            ]}
          />
          <span className="flex-1" />
          <Button size="sm" icon={Upload} loading={busy} onClick={upload}>
            Upload images
          </Button>
        </div>

        {assets.status === 'error' ? (
          <ErrorState size="sm" error={assets.error} onRetry={assets.reload} />
        ) : !assets.data ? (
          <SkeletonRows rows={3} />
        ) : list.length === 0 ? (
          <EmptyState
            size="sm"
            icon={Images}
            title={search || origin !== 'all' ? 'No images match' : 'The library is empty'}
            description="Upload JPEG, PNG, GIF or WEBP images, or generate one from the draft editor."
            actions={
              <Button size="sm" icon={ImagePlus} onClick={upload}>
                Upload images
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-[minmax(0,1fr)_280px]">
            <ul aria-label="Images" className="grid max-h-[52vh] grid-cols-3 content-start gap-2 overflow-y-auto pr-1 @2xl:grid-cols-4">
              {list.map((asset) => {
                const problem = attachmentProblem(asset)
                const isPicked = picked.includes(asset.id)
                return (
                  <li key={asset.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setActive(asset.id)
                        if (onPick && asset.available && !problem) toggle(asset)
                      }}
                      aria-pressed={onPick ? isPicked : undefined}
                      aria-label={asset.originalName}
                      className={cn(
                        'group relative block aspect-square w-full overflow-hidden rounded-md border transition-[border-color,box-shadow] focus-ring',
                        shown?.id === asset.id ? 'border-accent-line' : 'border-line',
                        isPicked && 'shadow-[0_0_0_2px_var(--accent)]'
                      )}
                    >
                      <AssetThumb url={asset.url} alt={asset.originalName} available={asset.available} className="size-full" />
                      {isPicked && (
                        <span className="absolute right-1.5 top-1.5 grid size-5 place-items-center rounded-full bg-accent text-accent-fg">
                          <Check size={12} strokeWidth={3} />
                        </span>
                      )}
                      <span className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/70 to-transparent px-1.5 pb-1 pt-4 text-left text-2xs text-white">
                        {asset.origin === 'generated' && <Sparkles size={10} />}
                        <span className="truncate">{asset.originalName}</span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
            {shown && (
              <aside aria-label="Image details" className="flex flex-col gap-3">
                <AssetThumb url={shown.url} alt={shown.originalName} available={shown.available} fit="contain" className="aspect-square w-full rounded-md border border-line" />
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
                  <dt className="text-fg-subtle">Name</dt>
                  <dd data-selectable className="truncate text-fg" title={shown.originalName}>
                    {shown.originalName}
                  </dd>
                  <dt className="text-fg-subtle">Source</dt>
                  <dd className="text-fg">{shown.origin === 'generated' ? 'AI-generated' : 'Uploaded'}</dd>
                  <dt className="text-fg-subtle">Type</dt>
                  <dd className="text-fg">
                    {IMAGE_TYPES[shown.mimeType].label}
                    {shown.animated ? ' · animated' : ''}
                  </dd>
                  <dt className="text-fg-subtle">Size</dt>
                  <dd className="tabular text-fg">
                    {shown.width}×{shown.height} · {formatBytes(shown.sizeBytes)}
                  </dd>
                  <dt className="text-fg-subtle">Added</dt>
                  <dd className="text-fg">{formatDateTime(shown.createdAt)}</dd>
                  <dt className="text-fg-subtle">Used by</dt>
                  <dd className="text-fg">{shown.usedBy ? `${shown.usedBy} draft${shown.usedBy === 1 ? '' : 's'}` : 'No drafts'}</dd>
                </dl>
                {shown.prompt && <p data-selectable className="line-clamp-4 text-2xs text-fg-subtle">“{shown.prompt}”</p>}
                {!shown.available && <StatusBadge tone="warning">The file is missing from the image folder</StatusBadge>}
                {attachmentProblem(shown) && <p className="text-xs text-warning">{attachmentProblem(shown)}</p>}
                <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setConfirmDelete(shown)} className="self-start hover:text-danger">
                  Delete image
                </Button>
              </aside>
            )}
          </div>
        )}
        {onPick && <p className="pt-3 text-2xs text-fg-faint">Choose up to {maxPick}. Images over X’s limits can’t be attached.</p>}
        </div>
      </Modal>
      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title="Delete this image?"
        description={
          confirmDelete?.usedBy
            ? `It is attached to ${confirmDelete.usedBy} draft${confirmDelete.usedBy === 1 ? '' : 's'}, so it can’t be deleted until it is removed from ${confirmDelete.usedBy === 1 ? 'that draft' : 'them'}.`
            : 'The file is removed from the app’s image folder. This can’t be undone.'
        }
        confirmLabel="Delete image"
        tone="danger"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && remove(confirmDelete)}
      />
    </>
  )
}
