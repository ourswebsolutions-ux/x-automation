import { Bookmark, BookmarkCheck, ImagePlus, Paperclip, RefreshCw, Settings2, Sparkles, Square, Wand2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { imageModelCapabilities, SIZE_LABEL, type ImageFormat } from '@shared/config/imageModels'
import { attachmentProblem } from '@shared/config/mediaLimits'
import { IMAGE_STYLES, type ImageAsset, type ImageGenerationRecord, type ImageStyle } from '@shared/types/images'
import { Button, Field, IconButton, Notice, Select, Spinner, StatusBadge, Switch, Textarea, useToast } from '@/components/ui'
import { AiErrorNotice } from '@/components/feature/AiErrorNotice'
import { AssetThumb } from '@/components/feature/AssetThumb'
import { ProviderModelSelect, type ProviderChoice } from '@/components/feature/ProviderModelSelect'
import { useImageProviders } from '@/data/assets'
import { useTextProviders } from '@/data/generator'
import { errorMessage, relay } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { formatBytes, formatNumber } from '@/lib/format'
import { settingsPath } from '@/app/navigation'

interface ImagePanelProps {
  postText: string
  draftId: string | null
  /** How many more images this draft can take. */
  slotsLeft: number
  onAttach: (asset: ImageAsset) => void
  onClose: () => void
}

const styleLabel = (s: ImageStyle) => s[0]!.toUpperCase() + s.slice(1)

/**
 * Image generation inside the editor. The optional prompt suggestion uses the
 * text provider; generation uses the image provider. Only options the chosen
 * model documents are offered. Results are real provider output saved to the
 * image folder; they join the library when saved or attached.
 */
export function ImagePanel(props: ImagePanelProps) {
  const toast = useToast()
  const navigate = useNavigate()
  const imageProviders = useImageProviders()
  const textProviders = useTextProviders()
  const [choice, setChoice] = useState<ProviderChoice>({ providerId: null, model: null })
  const [prompt, setPrompt] = useState('')
  const [style, setStyle] = useState<ImageStyle>('photographic')
  const [direction, setDirection] = useState('')
  const [size, setSize] = useState('1024x1024')
  const [quality, setQuality] = useState<string | null>(null)
  const [format, setFormat] = useState<ImageFormat | null>(null)
  const [transparent, setTransparent] = useState(false)
  const [count, setCount] = useState(1)
  const [running, setRunning] = useState<string | null>(null)
  const [suggesting, setSuggesting] = useState<string | null>(null)
  const [record, setRecord] = useState<ImageGenerationRecord | null>(null)
  const [suggestError, setSuggestError] = useState<{ kind: never; message: string; hint: string } | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [keptIds, setKeptIds] = useState<string[]>([])
  const onChoice = useCallback((next: ProviderChoice) => setChoice(next), [])

  const provider = imageProviders.usable.find((p) => p.id === choice.providerId) ?? null
  const caps = useMemo(() => imageModelCapabilities(choice.model ?? provider?.model), [choice.model, provider?.model])

  // A newly chosen provider brings its saved defaults; otherwise keep the user's choice if the model supports it.
  const [defaultsFor, setDefaultsFor] = useState<string | null>(null)
  useEffect(() => {
    const d = provider?.settings.image
    const fresh = provider ? provider.id !== defaultsFor : false
    if (provider && fresh) setDefaultsFor(provider.id)
    const pick = <T extends string>(current: T | null, saved: T | null | undefined, allowed: readonly T[]) =>
      fresh && saved && allowed.includes(saved) ? saved : current && allowed.includes(current) ? current : saved && allowed.includes(saved) ? saved : allowed[0]!
    setSize((s) => pick(s, d?.size, caps.sizes))
    setQuality((q) => (caps.qualities ? pick(q, d?.quality, caps.qualities) : null))
    setFormat((f) => (caps.formats ? pick<ImageFormat>(f, d?.format ?? 'jpeg', caps.formats) : null))
    setCount((c) => Math.min(c, caps.maxImages))
    if (!caps.transparentBackground) setTransparent(false)
  }, [caps, provider, defaultsFor])

  const suggest = async () => {
    const requestId = crypto.randomUUID()
    setSuggesting(requestId)
    setSuggestError(null)
    try {
      const outcome = await relay.images.suggestPrompt({ postText: props.postText, style, instructions: direction, requestId })
      if (outcome.ok) setPrompt(outcome.prompt)
      else setSuggestError(outcome.error as never)
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setSuggesting(null)
    }
  }

  const generate = async () => {
    const requestId = crypto.randomUUID()
    setRunning(requestId)
    setFailure(null)
    setRecord(null)
    try {
      const result = await relay.images.generate(
        { prompt, size, quality, format, transparent: transparent && caps.transparentBackground, count, draftId: props.draftId },
        { requestId, providerId: choice.providerId ?? undefined, model: choice.model ?? undefined }
      )
      setRecord(result)
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setRunning(null)
    }
  }

  const keep = async (asset: ImageAsset) => {
    try {
      await relay.assets.keep(asset.id)
      setKeptIds((k) => [...k, asset.id])
      toast({ tone: 'success', title: 'Saved to the image library' })
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not save', description: errorMessage(error) })
    }
  }

  const noImageProvider = !imageProviders.loading && imageProviders.usable.length === 0
  const noTextProvider = !textProviders.loading && textProviders.usable.length === 0
  const promptTooLong = prompt.length > caps.maxPromptChars
  const unique = record ? [...new Map(record.assets.map((a) => [a.id, a])).values()] : []

  return (
    <section aria-label="Image generation" className="flex flex-col gap-3 border-t border-line bg-surface-1/40 px-4 py-3.5 animate-fade-in">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-sm font-medium text-fg">
          <ImagePlus size={14} className="text-accent-text" /> Generate an image
        </span>
        <IconButton icon={X} label="Close image generation" size="sm" onClick={props.onClose} />
      </div>

      {noImageProvider ? (
        <Notice
          tone="warning"
          title="No image provider is ready"
          actions={
            <Button size="sm" icon={Settings2} onClick={() => navigate(settingsPath('ai'))}>
              Image settings
            </Button>
          }
        >
          Add and test an image provider to generate images. You can still upload your own images and attach them.
        </Notice>
      ) : (
        <>
          <div className="flex flex-col gap-2 rounded-md border border-line bg-surface-2 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-fg-muted">Prompt from the post</span>
              <span className="text-2xs text-fg-faint">Optional · uses your text provider · the post isn’t changed</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select<ImageStyle> size="sm" className="w-44" aria-label="Visual style" value={style} onChange={setStyle} options={IMAGE_STYLES.map((s) => ({ value: s, label: styleLabel(s) }))} />
              <input
                aria-label="Extra direction for the prompt"
                value={direction}
                maxLength={500}
                onChange={(e) => setDirection(e.target.value)}
                placeholder="Extra direction (optional), e.g. warm morning light"
                className="h-7 min-w-0 flex-1 basis-56 rounded-md border border-line-strong bg-surface-1 px-2.5 text-xs text-fg outline-none placeholder:text-fg-faint focus:border-accent-line"
              />
              {suggesting ? (
                <Button size="sm" icon={Square} onClick={() => void relay.ai.cancel(suggesting)}>
                  Cancel
                </Button>
              ) : (
                <Button size="sm" icon={Wand2} disabled={!props.postText.trim() || noTextProvider} onClick={suggest} title={noTextProvider ? 'Needs an AI text provider' : undefined}>
                  {prompt ? 'Suggest another' : 'Suggest a prompt'}
                </Button>
              )}
            </div>
            {!props.postText.trim() && <p className="text-2xs text-fg-faint">Write the post first to get a matching prompt — or just type your own below.</p>}
            {noTextProvider && <p className="text-2xs text-fg-faint">Prompt suggestions need an AI text provider; you can still write the prompt yourself.</p>}
            {suggestError && <AiErrorNotice error={suggestError} onRetry={suggest} />}
          </div>

          <Field label="Image prompt" htmlFor="image-prompt" error={promptTooLong ? `${caps.family} prompts can be up to ${caps.maxPromptChars.toLocaleString()} characters.` : null}>
            <Textarea id="image-prompt" rows={3} value={prompt} invalid={promptTooLong} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe the image: subject, setting, mood, composition…" />
          </Field>

          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 basis-80">
              <ProviderModelSelect providers={imageProviders.usable} value={choice} onChange={onChoice} disabled={Boolean(running)} kind="image" />
            </div>
            <Select<string> size="sm" className="w-48" aria-label="Image size" value={size} onChange={setSize} options={caps.sizes.map((s) => ({ value: s, label: SIZE_LABEL[s] ?? s }))} />
            {caps.qualities && (
              <Select<string> size="sm" className="w-32" aria-label="Image quality" value={quality} onChange={setQuality} options={caps.qualities.map((q) => ({ value: q, label: q[0]!.toUpperCase() + q.slice(1) }))} />
            )}
            {caps.formats && (
              <Select<ImageFormat> size="sm" className="w-28" aria-label="Output format" value={format} onChange={setFormat} options={caps.formats.map((f) => ({ value: f, label: f.toUpperCase() }))} />
            )}
            {caps.maxImages > 1 && (
              <Select<string>
                size="sm"
                className="w-28"
                aria-label="Number of images"
                value={String(count)}
                onChange={(v) => setCount(Number(v))}
                options={Array.from({ length: caps.maxImages }, (_, i) => ({ value: String(i + 1), label: `${i + 1} image${i ? 's' : ''}` }))}
              />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {caps.transparentBackground && (
              <label className="flex items-center gap-2 text-xs text-fg-muted">
                <Switch checked={transparent} onChange={setTransparent} aria-label="Transparent background" disabled={format === 'jpeg'} />
                Transparent background {format === 'jpeg' && <span className="text-fg-faint">(PNG or WEBP only)</span>}
              </label>
            )}
            {!caps.known && <span className="text-2xs text-fg-faint">Unrecognised model — only a square image and the prompt are sent.</span>}
            <span className="flex-1" />
            {running ? (
              <Button size="sm" icon={Square} onClick={() => void relay.ai.cancel(running)}>
                Cancel
              </Button>
            ) : (
              <Button size="sm" variant="primary" icon={Sparkles} disabled={!prompt.trim() || promptTooLong || !choice.providerId} onClick={generate}>
                {record ? 'Regenerate' : 'Generate'}
              </Button>
            )}
          </div>
          <p className="text-2xs text-fg-faint">Each generation is a billed request to the image provider.</p>
        </>
      )}

      {running && (
        <div className="flex items-center gap-3 rounded-md border border-dashed border-line-strong px-3 py-6 text-xs text-fg-muted" aria-live="polite">
          <Spinner size={14} /> Generating — this can take up to a minute. Nothing is shown until the provider returns an image.
        </div>
      )}
      {failure && <p className="text-xs text-danger">{failure}</p>}
      {record?.error && <AiErrorNotice error={record.error} onRetry={generate} />}
      {record?.status === 'succeeded' && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-fg-faint">
            <span>
              {record.providerName} · <span className="font-mono">{record.model}</span> · {SIZE_LABEL[record.size] ?? record.size}
              {record.quality ? ` · ${record.quality}` : ''}
            </span>
            {record.usage ? <span>{formatNumber(record.usage.totalTokens ?? 0)} tokens (reported)</span> : <span>No usage reported by the provider</span>}
            <span className="flex-1" />
            <Button size="sm" variant="ghost" icon={RefreshCw} onClick={generate} disabled={Boolean(running)}>
              Regenerate
            </Button>
          </div>
          {record.revisedPrompt && <p className="text-2xs text-fg-subtle">Provider revised the prompt: “{record.revisedPrompt}”</p>}
          <div className={cn('grid gap-2', unique.length > 1 ? 'grid-cols-2' : 'grid-cols-1 @4xl:grid-cols-2')}>
            {unique.map((asset) => {
              const problem = attachmentProblem(asset)
              const saved = asset.kept || keptIds.includes(asset.id)
              return (
                <figure key={asset.id} className="flex flex-col gap-2 rounded-md border border-line-strong bg-surface-2 p-2 animate-fade-in">
                  <AssetThumb url={asset.url} alt={`Generated: ${record.prompt.slice(0, 80)}`} available={asset.available} fit="contain" className="aspect-[3/2] w-full rounded-sm" />
                  <figcaption className="flex flex-wrap items-center gap-1.5">
                    <span className="tabular text-2xs text-fg-subtle">
                      {asset.width}×{asset.height} · {formatBytes(asset.sizeBytes)}
                    </span>
                    {problem && <StatusBadge tone="warning">Too large to attach</StatusBadge>}
                    <span className="flex-1" />
                    <Button size="sm" variant="ghost" icon={saved ? BookmarkCheck : Bookmark} disabled={saved} onClick={() => keep(asset)}>
                      {saved ? 'In library' : 'Save to library'}
                    </Button>
                    <Button size="sm" icon={Paperclip} disabled={Boolean(problem) || props.slotsLeft < 1} onClick={() => props.onAttach(asset)} title={problem ?? (props.slotsLeft < 1 ? 'This draft has no image slots left' : undefined)}>
                      Attach
                    </Button>
                  </figcaption>
                </figure>
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}
