import { Copy, FilePlus2, History, PenLine, RefreshCw, Settings2, Sparkles, Square, Wand2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { LENGTH_PROFILE_LIST, type LengthProfileId } from '@shared/config/postLimits'
import { LANGUAGES, TONES, type GenerationBrief, type GenerationRecord, type PostLength, type Tone } from '@shared/types/generator'
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  Notice,
  Panel,
  SegmentedControl,
  Select,
  SkeletonRows,
  Spinner,
  StatusBadge,
  StatusDot,
  Switch,
  Tabs,
  Textarea,
  useToast
} from '@/components/ui'
import { AiErrorNotice } from '@/components/feature/AiErrorNotice'
import { HashtagInput } from '@/components/feature/HashtagInput'
import { ProviderModelSelect, type ProviderChoice } from '@/components/feature/ProviderModelSelect'
import { useLengthProfile } from '@/data/drafts'
import { useGenerationHistory, useTextProviders } from '@/data/generator'
import { MOD_LABEL } from '@/hooks/useHotkey'
import { errorMessage, relay } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { formatDateTime, formatNumber, formatRelative } from '@/lib/format'
import { measurePost } from '@/lib/postLength'
import { settingsPath } from '@/app/navigation'
import { TOOL_LABEL } from '../posts/AssistPanel'

const STORAGE_KEY = 'relay.generator.brief'
const toneLabel = (t: Tone) => t[0]!.toUpperCase() + t.slice(1)

const EMPTY_BRIEF: Omit<GenerationBrief, 'lengthProfile'> = {
  topic: '',
  keyPoints: '',
  audience: '',
  tone: 'conversational',
  language: 'English',
  length: 'medium',
  variations: 3,
  hashtags: [],
  suggestHashtags: false,
  callToAction: '',
  instructions: ''
}

/** The brief is kept per viewer between visits (a convenience — losing it is harmless). */
function loadBrief(): Omit<GenerationBrief, 'lengthProfile'> {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<GenerationBrief> | null
    return stored ? { ...EMPTY_BRIEF, ...stored } : EMPTY_BRIEF
  } catch {
    return EMPTY_BRIEF
  }
}

/**
 * The AI half of Create Post: a brief → variations from your AI provider → open one in the editor
 * (or keep several as saved posts). Facts in the brief are the only facts the AI may use.
 */
export function AiComposer({ onOpenDraft }: { onOpenDraft: (draftId: string) => void }) {
  const toast = useToast()
  const navigate = useNavigate()
  const providers = useTextProviders()
  const { profile, setProfile } = useLengthProfile()
  const [brief, setBrief] = useState(loadBrief)
  const [choice, setChoice] = useState<ProviderChoice>({ providerId: null, model: null })
  const [running, setRunning] = useState<string | null>(null)
  const [shown, setShown] = useState<GenerationRecord | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [tab, setTab] = useState<'results' | 'history'>('results')
  const history = useGenerationHistory({ limit: 40 })
  const onChoice = useCallback((next: ProviderChoice) => setChoice(next), [])

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(brief))
    } catch {
      // Storage unavailable — the brief simply isn't remembered.
    }
  }, [brief])

  const set = <K extends keyof typeof brief>(key: K, value: (typeof brief)[K]) => setBrief((b) => ({ ...b, [key]: value }))
  const topicError = brief.topic.trim().length + brief.keyPoints.trim().length < 3 ? 'Describe a topic or the main message.' : null
  const noProvider = !providers.loading && providers.usable.length === 0

  const generate = async () => {
    setSubmitted(true)
    if (topicError || running || !choice.providerId) return
    const requestId = crypto.randomUUID()
    setRunning(requestId)
    setFailure(null)
    setTab('results')
    try {
      const record = await relay.generator.generate(
        { ...brief, lengthProfile: profile.id },
        { requestId, providerId: choice.providerId, model: choice.model ?? undefined }
      )
      setShown(record)
      history.reload()
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setRunning(null)
    }
  }

  const saveDraft = async (record: GenerationRecord, text: string, openAfter: boolean) => {
    try {
      const draft = await relay.drafts.save({ body: text, hashtags: [], accountId: null, aiAssisted: true, sourceGenerationId: record.id })
      if (openAfter) onOpenDraft(draft.id)
      else toast({ tone: 'success', title: 'Saved as a post', action: { label: 'Open', onClick: () => onOpenDraft(draft.id) } })
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not save the draft', description: errorMessage(error) })
    }
  }

  return (
    <div className="flex flex-col gap-4">

      {noProvider && (
        <Notice
          tone="warning"
          title="No AI provider is ready"
          actions={
            <Button size="sm" icon={Settings2} onClick={() => navigate(settingsPath('ai'))}>
              AI provider settings
            </Button>
          }
        >
          Generation needs an enabled provider with a key and a model. Until then you can still write and save drafts by hand, and browse past generations.
        </Notice>
      )}

      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        <form
          aria-label="Generation brief"
          className="flex flex-col gap-4 rounded-lg border border-line bg-surface-2 p-4 @5xl:sticky @5xl:top-4 @5xl:self-start"
          onSubmit={(e) => {
            e.preventDefault()
            void generate()
          }}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault()
              void generate()
            }
          }}
        >
          <Field label="Topic" htmlFor="gen-topic" error={submitted ? topicError : null}>
            <Input id="gen-topic" data-autofocus value={brief.topic} maxLength={200} placeholder="e.g. Our new offline mode" invalid={submitted && Boolean(topicError)} onChange={(e) => set('topic', e.target.value)} />
          </Field>
          <Field label="Main message or key points" htmlFor="gen-points">
            <Textarea id="gen-points" rows={3} value={brief.keyPoints} maxLength={2000} placeholder="What must the post say? Facts here are the only facts the AI may use." onChange={(e) => set('keyPoints', e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Audience" htmlFor="gen-audience">
              <Input id="gen-audience" value={brief.audience} maxLength={200} placeholder="e.g. indie developers" onChange={(e) => set('audience', e.target.value)} />
            </Field>
            <Field label="Language" htmlFor="gen-language">
              <Select<string> id="gen-language" value={brief.language} onChange={(v) => set('language', v)} options={LANGUAGES.map((l) => ({ value: l, label: l }))} />
            </Field>
          </div>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="pb-1.5 text-xs font-medium text-fg-muted">Tone</legend>
            <div role="radiogroup" aria-label="Tone" className="flex flex-wrap gap-1.5">
              {TONES.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={brief.tone === t}
                  onClick={() => set('tone', t)}
                  className={cn(
                    'h-7 rounded-sm border px-2.5 text-xs transition-colors focus-ring',
                    brief.tone === t ? 'border-accent-line bg-accent-soft text-accent-text' : 'border-line-strong text-fg-muted hover:border-line-heavy hover:text-fg'
                  )}
                >
                  {toneLabel(t)}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Length" htmlFor="gen-length">
              <SegmentedControl<PostLength>
                size="sm"
                value={brief.length}
                onChange={(v) => set('length', v)}
                options={[
                  { value: 'short', label: 'Short' },
                  { value: 'medium', label: 'Medium' },
                  { value: 'long', label: profile.id === 'premium' ? 'Long-form' : 'Full' }
                ]}
              />
            </Field>
            <Field label="Variations" htmlFor="gen-count">
              <SegmentedControl<string> size="sm" value={String(brief.variations)} onChange={(v) => set('variations', Number(v))} options={['1', '2', '3', '4', '5'].map((n) => ({ value: n, label: n }))} />
            </Field>
          </div>
          <Field label="Length limit" htmlFor="gen-profile" hint={profile.description}>
            <Select<LengthProfileId> id="gen-profile" value={profile.id} onChange={setProfile} options={LENGTH_PROFILE_LIST.map((p) => ({ value: p.id, label: p.label }))} />
          </Field>
          <Field label="Hashtags to include" htmlFor="gen-hashtags" aside={<span className="text-2xs text-fg-faint">Optional</span>}>
            <HashtagInput id="gen-hashtags" value={brief.hashtags} max={10} onChange={(v) => set('hashtags', v)} />
          </Field>
          <label className="-mt-1 flex items-center justify-between gap-3 text-sm text-fg">
            Let the AI suggest hashtags too
            <Switch checked={brief.suggestHashtags} onChange={(v) => set('suggestHashtags', v)} aria-label="Let the AI suggest hashtags" />
          </label>
          <Field label="Call to action" htmlFor="gen-cta" aside={<span className="text-2xs text-fg-faint">Optional</span>}>
            <Input id="gen-cta" value={brief.callToAction} maxLength={200} placeholder="e.g. Try it free this week" onChange={(e) => set('callToAction', e.target.value)} />
          </Field>
          <Field label="Additional instructions" htmlFor="gen-extra" aside={<span className="text-2xs text-fg-faint">Optional</span>}>
            <Textarea id="gen-extra" rows={2} value={brief.instructions} maxLength={1000} placeholder="e.g. No emoji. Mention it works on Windows." onChange={(e) => set('instructions', e.target.value)} />
          </Field>
          <div className="flex flex-col gap-2 border-t border-line pt-3">
            <ProviderModelSelect providers={providers.usable} value={choice} onChange={onChoice} disabled={Boolean(running)} size="md" />
            <div className="flex items-center gap-2">
              {running ? (
                <Button icon={Square} onClick={() => void relay.ai.cancel(running)} className="flex-1">
                  Cancel
                </Button>
              ) : (
                <Button type="submit" variant="primary" icon={Sparkles} disabled={noProvider || !choice.providerId} className="flex-1">
                  Generate {brief.variations > 1 ? `${brief.variations} variations` : 'post'}
                </Button>
              )}
              <IconButton icon={RefreshCw} label="Reset the brief" onClick={() => setBrief(EMPTY_BRIEF)} disabled={Boolean(running)} />
            </div>
            <p className="text-2xs text-fg-faint">
              {MOD_LABEL}+Enter to generate · one billed request to the provider, whatever the number of variations.
            </p>
          </div>
        </form>

        <div className="flex min-w-0 flex-col gap-3">
          <Tabs<'results' | 'history'>
            aria-label="Generator view"
            value={tab}
            onChange={setTab}
            items={[
              { value: 'results', label: 'Results', icon: Wand2, count: shown?.results.length || undefined },
              { value: 'history', label: 'History', icon: History, count: history.data?.length }
            ]}
          />
          {tab === 'results' ? (
            <Results
              record={shown}
              running={Boolean(running)}
              failure={failure}
              maxWeighted={profile.maxWeighted}
              onRegenerate={shown?.operation === 'generate' ? generate : undefined}
              onSave={(text) => shown && saveDraft(shown, text, false)}
              onOpen={(text) => shown && saveDraft(shown, text, true)}
            />
          ) : (
            <HistoryList
              records={history.data}
              error={history.status === 'error' ? history.error : null}
              onRetry={history.reload}
              onShow={(record) => {
                setShown(record)
                setTab('results')
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function Results(props: {
  record: GenerationRecord | null
  running: boolean
  failure: string | null
  maxWeighted: number
  onRegenerate?: () => void
  onSave: (text: string) => void
  onOpen: (text: string) => void
}) {
  const { record } = props
  if (props.running) {
    return (
      <Panel>
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <Spinner size={18} />
          <p className="text-sm text-fg-muted">Writing variations…</p>
          <p className="text-xs text-fg-subtle">Nothing is shown until the provider answers.</p>
        </div>
      </Panel>
    )
  }
  if (props.failure) return <p className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">{props.failure}</p>
  if (!record) {
    return (
      <Panel>
        <EmptyState icon={Sparkles} title="No results yet" description="Fill in the brief and generate. Results appear here side by side so you can compare and keep the best." />
      </Panel>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle">
        <StatusBadge tone={record.status === 'succeeded' ? 'success' : record.status === 'cancelled' ? 'neutral' : 'danger'} dot>
          {record.status === 'succeeded' ? `${record.results.length} result${record.results.length === 1 ? '' : 's'}` : record.status === 'cancelled' ? 'Cancelled' : 'Failed'}
        </StatusBadge>
        <span>{record.operation === 'generate' ? 'Generated' : TOOL_LABEL[record.operation]} {formatRelative(record.createdAt)}</span>
        <span>· {record.providerName}</span>
        {record.model && <span className="font-mono">· {record.model}</span>}
        {record.usage && <span>· {formatNumber(record.usage.inputTokens ?? 0)} in / {formatNumber(record.usage.outputTokens ?? 0)} out tokens (reported)</span>}
        {record.status === 'succeeded' && !record.usage && <span>· no token usage reported</span>}
        <span className="flex-1" />
        {props.onRegenerate && (
          <Button size="sm" icon={RefreshCw} onClick={props.onRegenerate}>
            Regenerate
          </Button>
        )}
      </div>
      {record.error && <AiErrorNotice error={record.error} onRetry={props.onRegenerate} />}
      {record.finishReason === 'length' && record.status === 'succeeded' && (
        <p className="text-xs text-warning">The model stopped at its output limit — the last result may be cut short.</p>
      )}
      {record.operation === 'hashtags' ? (
        <Panel title="Suggested hashtags">
          <p data-selectable className="text-sm text-info">{record.results.map((t) => `#${t}`).join(' ')}</p>
        </Panel>
      ) : (
        <div className="grid grid-cols-1 gap-3 @4xl:grid-cols-2">
          {record.results.map((text, i) => (
            <Variation key={`${record.id}-${i}`} index={i} text={text} maxWeighted={props.maxWeighted} onSave={() => props.onSave(text)} onOpen={() => props.onOpen(text)} />
          ))}
        </div>
      )}
    </div>
  )
}

function Variation(props: { index: number; text: string; maxWeighted: number; onSave: () => void; onOpen: () => void }) {
  const toast = useToast()
  const length = useMemo(() => measurePost(props.text, props.maxWeighted), [props.text, props.maxWeighted])
  return (
    <article className="flex flex-col gap-3 rounded-lg border border-line bg-surface-2 p-4 animate-fade-in" style={{ animationDelay: `${props.index * 50}ms` }}>
      <header className="flex items-center justify-between text-2xs font-medium uppercase tracking-[0.07em] text-fg-faint">
        Variation {props.index + 1}
        <span className={cn('tabular normal-case tracking-normal', length.isOver ? 'text-danger' : 'text-fg-subtle')}>
          {length.weighted} / {props.maxWeighted}
        </span>
      </header>
      <p data-selectable className="flex-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-fg">
        {props.text}
      </p>
      {length.isOver && <StatusBadge tone="danger">Over the limit — shorten before posting</StatusBadge>}
      <footer className="flex flex-wrap gap-1.5">
        <Button size="sm" icon={PenLine} onClick={props.onOpen}>
          Use this post
        </Button>
        <Button size="sm" variant="ghost" icon={FilePlus2} onClick={props.onSave}>
          Save for later
        </Button>
        <IconButton icon={Copy} label="Copy" size="sm" onClick={() => void navigator.clipboard.writeText(props.text).then(() => toast({ tone: 'success', title: 'Copied' }))} />
      </footer>
    </article>
  )
}

function HistoryList(props: { records: GenerationRecord[] | undefined; error: unknown; onRetry: () => void; onShow: (record: GenerationRecord) => void }) {
  if (props.error) return <ErrorState size="sm" error={props.error} onRetry={props.onRetry} />
  if (!props.records) return <SkeletonRows rows={4} />
  if (props.records.length === 0) {
    return (
      <Panel>
        <EmptyState size="sm" icon={History} title="No generations yet" description="Every generation and AI edit is kept here with its settings and results." />
      </Panel>
    )
  }
  return (
    <Panel padded={false}>
      <ul aria-label="Generation history" className="divide-y divide-line">
        {props.records.map((r) => (
          <li key={r.id}>
            <button type="button" onClick={() => props.onShow(r)} className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-highlight focus-visible:bg-highlight focus-visible:outline-none">
              <StatusDot tone={r.status === 'succeeded' ? 'success' : r.status === 'cancelled' ? 'neutral' : 'danger'} className="mt-1.5" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-baseline gap-x-2 text-sm text-fg">
                  {r.operation === 'generate' ? 'Generate' : TOOL_LABEL[r.operation]}
                  {r.status === 'succeeded' && <span className="text-xs text-fg-subtle">{r.results.length} result{r.results.length === 1 ? '' : 's'}</span>}
                  <span className="text-xs text-fg-faint">
                    {r.providerName}
                    {r.model ? ` · ${r.model}` : ''}
                  </span>
                </span>
                <span className={cn('truncate text-xs', r.error ? 'text-danger' : 'text-fg-subtle')}>
                  {r.error ? r.error.message : r.operation === 'hashtags' ? r.results.map((t) => `#${t}`).join(' ') : (r.results[0] ?? '')}
                </span>
              </span>
              <time dateTime={r.createdAt} title={formatDateTime(r.createdAt)} className="tabular shrink-0 text-2xs text-fg-faint">
                {formatRelative(r.createdAt)}
              </time>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  )
}
