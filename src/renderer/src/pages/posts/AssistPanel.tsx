import {
  ArrowRightLeft,
  Copy,
  Expand,
  FilePlus2,
  Hash,
  Languages,
  Megaphone,
  Minimize2,
  Plus,
  Replace,
  Settings2,
  Shapes,
  Sparkles,
  Square,
  SpellCheck,
  Type,
  Wand2,
  X,
  type LucideIcon
} from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { composePost, type LengthProfile } from '@shared/config/postLimits'
import { LANGUAGES, TONES, type AssistTool, type GenerationRecord, type Tone } from '@shared/types/generator'
import { Button, IconButton, Notice, Select, Spinner, StatusBadge, useToast } from '@/components/ui'
import { AiErrorNotice } from '@/components/feature/AiErrorNotice'
import { ProviderModelSelect, type ProviderChoice } from '@/components/feature/ProviderModelSelect'
import { useTextProviders } from '@/data/generator'
import { errorMessage, relay } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { formatNumber } from '@/lib/format'
import { measurePost } from '@/lib/postLength'
import { settingsPath } from '@/app/navigation'

const TOOLS: { id: AssistTool; label: string; icon: LucideIcon; hint: string }[] = [
  { id: 'rewrite', label: 'Rewrite', icon: Wand2, hint: 'Fresh wording, same meaning' },
  { id: 'improve', label: 'Improve', icon: SpellCheck, hint: 'Clarity and grammar' },
  { id: 'shorten', label: 'Shorten', icon: Minimize2, hint: 'Tighter version' },
  { id: 'expand', label: 'Expand', icon: Expand, hint: 'More detail from what is there' },
  { id: 'tone', label: 'Change tone', icon: Type, hint: 'Rewrite in another tone' },
  { id: 'translate', label: 'Translate', icon: Languages, hint: 'Into another language' },
  { id: 'alternatives', label: 'Alternatives', icon: Shapes, hint: 'Several different versions' },
  { id: 'hashtags', label: 'Hashtags', icon: Hash, hint: 'Suggest relevant hashtags' },
  { id: 'opening', label: 'Opening', icon: ArrowRightLeft, hint: 'Stronger first sentence' },
  { id: 'cta', label: 'Call to action', icon: Megaphone, hint: 'Refine the closing ask' }
]
export const TOOL_LABEL = Object.fromEntries(TOOLS.map((t) => [t.id, t.label])) as Record<AssistTool, string>

const TONE_LABEL = (t: Tone) => t[0]!.toUpperCase() + t.slice(1)

interface AssistPanelProps {
  text: string
  hashtags: string[]
  draftId: string | null
  profile: LengthProfile
  onReplace: (text: string, generationId: string) => void
  onAddHashtags: (tags: string[]) => void
  onSaveAsDraft: (text: string, generationId: string) => Promise<void>
  onClose: () => void
}

/**
 * AI editing tools for the open draft. Results are shown next to the original
 * and never applied automatically — the user picks one and chooses to replace
 * the text or save it as a new draft.
 */
export function AssistPanel(props: AssistPanelProps) {
  const toast = useToast()
  const navigate = useNavigate()
  const providers = useTextProviders()
  const [choice, setChoice] = useState<ProviderChoice>({ providerId: null, model: null })
  const [tool, setTool] = useState<AssistTool>('rewrite')
  const [tone, setTone] = useState<Tone>('conversational')
  const [language, setLanguage] = useState<string>('Spanish')
  const [count, setCount] = useState(3)
  const [running, setRunning] = useState<string | null>(null)
  const [record, setRecord] = useState<GenerationRecord | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const onChoice = useCallback((next: ProviderChoice) => setChoice(next), [])
  const sourceRef = useRef('')

  const run = async () => {
    const requestId = crypto.randomUUID()
    sourceRef.current = props.text
    setRunning(requestId)
    setRecord(null)
    setFailure(null)
    try {
      const result = await relay.generator.assist(
        {
          tool,
          text: props.text,
          hashtags: props.hashtags,
          draftId: props.draftId,
          lengthProfile: props.profile.id,
          ...(tool === 'tone' ? { tone } : {}),
          ...(tool === 'translate' ? { language } : {}),
          ...(tool === 'alternatives' ? { variations: count } : {})
        },
        { requestId, providerId: choice.providerId ?? undefined, model: choice.model ?? undefined }
      )
      setRecord(result)
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setRunning(null)
    }
  }

  const noProvider = !providers.loading && providers.usable.length === 0
  const original = composePost(sourceRef.current || props.text, props.hashtags)

  return (
    <section aria-label="AI assist" className="flex flex-col gap-3 border-t border-line bg-surface-1/40 px-4 py-3.5 animate-fade-in">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-sm font-medium text-fg">
          <Sparkles size={14} className="text-accent-text" /> AI assist
        </span>
        <IconButton icon={X} label="Close AI assist" size="sm" onClick={props.onClose} />
      </div>

      {noProvider ? (
        <Notice
          tone="warning"
          title="No AI provider is ready"
          actions={
            <Button size="sm" icon={Settings2} onClick={() => navigate(settingsPath('ai'))}>
              AI provider settings
            </Button>
          }
        >
          Add and test an AI provider to use these tools. You can keep writing and saving drafts without one.
        </Notice>
      ) : (
        <>
          <div role="radiogroup" aria-label="AI tool" className="flex flex-wrap gap-1.5">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={tool === t.id}
                title={t.hint}
                onClick={() => setTool(t.id)}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-sm border px-2.5 text-xs transition-colors focus-ring',
                  tool === t.id ? 'border-accent-line bg-accent-soft text-accent-text' : 'border-line-strong text-fg-muted hover:border-line-heavy hover:text-fg'
                )}
              >
                <t.icon size={12} strokeWidth={1.9} />
                {t.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {tool === 'tone' && (
              <Select<Tone> size="sm" className="w-44" aria-label="Target tone" value={tone} onChange={setTone} options={TONES.map((t) => ({ value: t, label: TONE_LABEL(t) }))} />
            )}
            {tool === 'translate' && (
              <Select<string> size="sm" className="w-48" aria-label="Target language" value={language} onChange={setLanguage} options={LANGUAGES.map((l) => ({ value: l, label: l }))} />
            )}
            {tool === 'alternatives' && (
              <Select<string>
                size="sm"
                className="w-32"
                aria-label="Number of alternatives"
                value={String(count)}
                onChange={(v) => setCount(Number(v))}
                options={[2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n} versions` }))}
              />
            )}
            <div className="min-w-0 flex-1 basis-72">
              <ProviderModelSelect providers={providers.usable} value={choice} onChange={onChoice} disabled={Boolean(running)} />
            </div>
            {running ? (
              <Button size="sm" icon={Square} onClick={() => void relay.ai.cancel(running)}>
                Cancel
              </Button>
            ) : (
              <Button size="sm" variant="primary" icon={Sparkles} disabled={!props.text.trim() || !choice.providerId} onClick={run}>
                {TOOL_LABEL[tool]}
              </Button>
            )}
          </div>
          {!props.text.trim() && <p className="text-xs text-fg-subtle">Write some text first — the tools work on the draft’s text.</p>}
        </>
      )}

      {running && (
        <p className="flex items-center gap-2 text-xs text-fg-muted">
          <Spinner size={12} /> Asking the provider… the original text stays as it is.
        </p>
      )}
      {failure && <p className="text-xs text-danger">{failure}</p>}
      {record?.error && <AiErrorNotice error={record.error} onRetry={run} />}
      {record?.status === 'succeeded' && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-fg-faint">
            <span>
              {TOOL_LABEL[record.operation as AssistTool]} · {record.providerName} · <span className="font-mono">{record.model}</span>
            </span>
            {record.usage && <span>{formatNumber(record.usage.totalTokens ?? 0)} tokens (reported)</span>}
            {record.finishReason === 'length' && <span className="text-warning">Stopped at the output limit</span>}
          </div>
          {record.operation === 'hashtags' ? (
            <HashtagSuggestions tags={record.results} existing={props.hashtags} onAdd={props.onAddHashtags} />
          ) : (
            <div className="grid grid-cols-1 gap-2 @4xl:grid-cols-2">
              <div className="flex flex-col gap-1.5 rounded-md border border-dashed border-line-strong p-3">
                <span className="text-2xs font-medium uppercase tracking-[0.07em] text-fg-faint">Original</span>
                <p data-selectable className="whitespace-pre-wrap break-words text-sm text-fg-subtle">
                  {original}
                </p>
              </div>
              {record.results.map((result, index) => (
                <Suggestion
                  key={index}
                  index={index}
                  text={result}
                  hashtags={props.hashtags}
                  profile={props.profile}
                  onReplace={() => {
                    props.onReplace(result, record.id)
                    toast({ tone: 'info', title: 'Draft text replaced', description: 'Not saved yet — review it, then save. Reset brings the saved text back.' })
                  }}
                  onSave={() => props.onSaveAsDraft(result, record.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function Suggestion(props: { index: number; text: string; hashtags: string[]; profile: LengthProfile; onReplace: () => void; onSave: () => Promise<void> }) {
  const toast = useToast()
  const [saving, setSaving] = useState(false)
  const length = measurePost(composePost(props.text, props.hashtags), props.profile.maxWeighted)
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line-strong bg-surface-2 p-3 animate-fade-in">
      <span className="flex items-center justify-between text-2xs font-medium uppercase tracking-[0.07em] text-fg-faint">
        Suggestion {props.index + 1}
        <span className={cn('tabular normal-case tracking-normal', length.isOver ? 'text-danger' : 'text-fg-subtle')}>
          {length.weighted} / {props.profile.maxWeighted}
        </span>
      </span>
      <p data-selectable className="flex-1 whitespace-pre-wrap break-words text-sm text-fg">
        {props.text}
      </p>
      {length.isOver && <StatusBadge tone="danger">Over the limit</StatusBadge>}
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" icon={Replace} onClick={props.onReplace}>
          Use this
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={FilePlus2}
          loading={saving}
          onClick={async () => {
            setSaving(true)
            try {
              await props.onSave()
            } finally {
              setSaving(false)
            }
          }}
        >
          Save as new draft
        </Button>
        <IconButton
          icon={Copy}
          label="Copy"
          size="sm"
          onClick={() => void navigator.clipboard.writeText(props.text).then(() => toast({ tone: 'success', title: 'Copied' }))}
        />
      </div>
    </div>
  )
}

function HashtagSuggestions({ tags, existing, onAdd }: { tags: string[]; existing: string[]; onAdd: (tags: string[]) => void }) {
  const have = new Set(existing.map((t) => t.toLowerCase()))
  const fresh = tags.filter((t) => !have.has(t.toLowerCase()))
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line-strong bg-surface-2 p-3">
      <div className="flex flex-wrap gap-1.5">
        {tags.map((tag) => {
          const added = have.has(tag.toLowerCase())
          return (
            <button
              key={tag}
              type="button"
              disabled={added}
              onClick={() => onAdd([tag])}
              className={cn(
                'inline-flex h-7 items-center gap-1 rounded-sm border px-2 text-xs transition-colors focus-ring',
                added ? 'border-line text-fg-faint' : 'border-line-strong text-fg-muted hover:border-accent-line hover:text-accent-text'
              )}
            >
              {!added && <Plus size={11} />}#{tag}
              {added && <span className="text-2xs">added</span>}
            </button>
          )
        })}
      </div>
      {fresh.length > 1 && (
        <Button size="sm" variant="ghost" icon={Plus} onClick={() => onAdd(fresh)} className="self-start">
          Add all {fresh.length}
        </Button>
      )}
    </div>
  )
}
