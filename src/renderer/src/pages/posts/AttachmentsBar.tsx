import { ArrowLeft, ArrowRight, ImagePlus, Images, Replace, Sparkles, Trash2, Upload } from 'lucide-react'
import { useState } from 'react'
import { attachmentProblem, attachmentSetProblem, X_MEDIA_LIMITS, type ImageMime } from '@shared/config/mediaLimits'
import type { MediaAttachment } from '@shared/types/domain'
import type { ImageAsset } from '@shared/types/images'
import { Button, IconButton } from '@/components/ui'
import { AssetThumb } from '@/components/feature/AssetThumb'
import { cn } from '@/lib/cn'
import { formatBytes } from '@/lib/format'

export const toAttachment = (asset: ImageAsset, altText = ''): MediaAttachment => ({
  id: asset.id,
  kind: 'image',
  url: asset.url,
  altText,
  mimeType: asset.mimeType,
  width: asset.width,
  height: asset.height,
  sizeBytes: asset.sizeBytes,
  animated: asset.animated,
  available: asset.available
})

export function mediaProblems(media: MediaAttachment[]): { set: string | null; byId: Record<string, string> } {
  const byId: Record<string, string> = {}
  for (const m of media) {
    const problem = !m.available ? 'The file is missing — remove or replace it.' : attachmentProblem({ mimeType: m.mimeType as ImageMime, sizeBytes: m.sizeBytes, animated: m.animated })
    if (problem) byId[m.id] = problem
    if (m.altText.length > X_MEDIA_LIMITS.maxAltTextChars) byId[m.id] = `Descriptions can be up to ${X_MEDIA_LIMITS.maxAltTextChars} characters.`
  }
  return { set: attachmentSetProblem(media), byId }
}

/** How many more images fit (an animated GIF fills the post on its own). */
export const slotsLeft = (media: MediaAttachment[]) => (media.some((m) => m.animated) ? 0 : X_MEDIA_LIMITS.maxPhotos - media.length)

interface AttachmentsBarProps {
  media: MediaAttachment[]
  disabled: boolean
  uploading: boolean
  onChange: (media: MediaAttachment[]) => void
  onUpload: () => void
  onLibrary: () => void
  onGenerate: () => void
  onReplace: (index: number) => void
}

/** The draft's images: order, descriptions, replace and remove — checked against X’s verified limits. */
export function AttachmentsBar(props: AttachmentsBarProps) {
  const { media } = props
  const problems = mediaProblems(media)
  const [editingAlt, setEditingAlt] = useState<string | null>(null)
  const left = slotsLeft(media)

  const move = (index: number, delta: number) => {
    const next = [...media]
    const [item] = next.splice(index, 1)
    next.splice(index + delta, 0, item!)
    props.onChange(next)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs font-medium text-fg-muted">Images</span>
        <span className="text-2xs text-fg-faint">
          {media.length ? `${media.length} of ${media.some((m) => m.animated) ? 1 : X_MEDIA_LIMITS.maxPhotos}` : 'Text only'} · JPEG, PNG, GIF, WEBP up to 5 MB (animated GIF 15 MB)
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" icon={Upload} loading={props.uploading} disabled={props.disabled || left < 1} onClick={props.onUpload}>
          Upload
        </Button>
        <Button size="sm" variant="ghost" icon={Images} disabled={props.disabled || left < 1} onClick={props.onLibrary}>
          Library
        </Button>
        <Button size="sm" variant="ghost" icon={Sparkles} disabled={props.disabled || left < 1} onClick={props.onGenerate}>
          Generate
        </Button>
      </div>

      {media.length > 0 && (
        <ul aria-label="Attached images" className="flex flex-wrap gap-2">
          {media.map((m, index) => {
            const problem = problems.byId[m.id]
            return (
              <li key={m.id} className={cn('flex w-40 flex-col gap-1.5 rounded-md border bg-surface-1 p-1.5 animate-fade-in', problem ? 'border-danger/50' : 'border-line-strong')}>
                <div className="relative">
                  <AssetThumb url={m.url} alt={m.altText || `Image ${index + 1}`} available={m.available} className="aspect-[4/3] w-full rounded-sm" />
                  <span className="absolute left-1 top-1 rounded-xs bg-black/60 px-1 text-2xs text-white tabular">{index + 1}</span>
                </div>
                <span className="tabular truncate text-2xs text-fg-subtle">
                  {m.width}×{m.height} · {formatBytes(m.sizeBytes)}
                  {m.animated ? ' · GIF' : ''}
                </span>
                {editingAlt === m.id ? (
                  <textarea
                    autoFocus
                    aria-label={`Description for image ${index + 1}`}
                    rows={3}
                    maxLength={X_MEDIA_LIMITS.maxAltTextChars + 50}
                    defaultValue={m.altText}
                    onBlur={(e) => {
                      props.onChange(media.map((x) => (x.id === m.id ? { ...x, altText: e.target.value.trim() } : x)))
                      setEditingAlt(null)
                    }}
                    className="w-full resize-none rounded-sm border border-line-strong bg-surface-2 p-1.5 text-2xs text-fg outline-none focus:border-accent-line"
                    placeholder="Describe the image for people using screen readers"
                  />
                ) : (
                  <button
                    type="button"
                    disabled={props.disabled}
                    onClick={() => setEditingAlt(m.id)}
                    className={cn('truncate rounded-xs text-left text-2xs focus-ring', m.altText ? 'text-fg-muted' : 'text-accent-text hover:underline')}
                    title={m.altText || undefined}
                  >
                    {m.altText || '+ Add description'}
                  </button>
                )}
                {problem && <p className="text-2xs leading-snug text-danger">{problem}</p>}
                <div className="flex items-center">
                  <IconButton icon={ArrowLeft} label="Move earlier" size="sm" disabled={props.disabled || index === 0} onClick={() => move(index, -1)} />
                  <IconButton icon={ArrowRight} label="Move later" size="sm" disabled={props.disabled || index === media.length - 1} onClick={() => move(index, 1)} />
                  <span className="flex-1" />
                  <IconButton icon={Replace} label="Replace image" size="sm" disabled={props.disabled} onClick={() => props.onReplace(index)} />
                  <IconButton icon={Trash2} label="Remove image" size="sm" disabled={props.disabled} onClick={() => props.onChange(media.filter((x) => x.id !== m.id))} />
                </div>
              </li>
            )
          })}
          {left > 0 && !props.disabled && (
            <li>
              <button
                type="button"
                onClick={props.onLibrary}
                aria-label="Add another image"
                className="grid h-full min-h-32 w-24 place-items-center rounded-md border border-dashed border-line-strong text-fg-faint transition-colors hover:border-accent-line hover:text-accent-text focus-ring"
              >
                <ImagePlus size={18} />
              </button>
            </li>
          )}
        </ul>
      )}
      {problems.set && <p className="text-xs text-danger">{problems.set}</p>}
    </div>
  )
}
