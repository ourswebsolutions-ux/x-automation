import { CircleX, ClipboardCopy, Eraser, ListChecks, Save, TriangleAlert, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { BULK_MAX_ITEMS, parseBulk, reviewItems, type BulkKind } from '@shared/lib/bulkParse'
import type { BulkSaveResult } from '@shared/types/domain'
import { Button, Field, IconButton, Input, Panel, SegmentedControl, Textarea, useToast } from '@/components/ui'
import { useLengthProfile } from '@/data/drafts'
import { errorMessage, relay } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { pluralize } from '@/lib/format'
import { measurePost } from '@/lib/postLength'

const COPY = {
  post: {
    title: 'Bulk posts',
    noun: ['post', 'posts'],
    save: 'Save All as Drafts',
    saved: (n: number) => `${pluralize(n, 'draft')} saved successfully`,
    example: '1. First unique post with relevant hashtags #Example\n2. Second unique post with relevant hashtags #Business\n3. Third unique post with relevant hashtags #Technology',
    prompt:
      'Write 300 different X (Twitter) posts about [your topic]. Number them 1. 2. 3. … — one post per number. Each post under 280 characters, with 1–3 relevant hashtags. No introduction and no closing notes.'
  },
  comment: {
    title: 'Bulk comments',
    noun: ['comment', 'comments'],
    save: 'Save All as Comment Drafts',
    saved: (n: number) => `${pluralize(n, 'comment draft')} saved successfully`,
    example: '1. First thoughtful comment that adds to the post\n2. Second comment with a different point of view\n3. Third comment asking a relevant question',
    prompt:
      'Write 300 different short replies (comments) for X (Twitter) posts about [your topic]. Number them 1. 2. 3. … — one comment per number. Each under 280 characters, relevant and different from the others. No introduction and no closing notes.'
  }
} as const

const FORMAT_LABEL = { numbered: 'Numbered list', paragraphs: 'Separated by blank lines', lines: 'One per line', empty: '' } as const

/**
 * Bulk posts or comments, pasted from ChatGPT (used separately — no AI service is called here): the
 * paste is split into items, shown for review and editing, and saved in one go. A save sends one
 * request id for this exact list, so a double click or a retry never saves it twice; a failed save
 * keeps everything as it was.
 */
export function BulkComposer({ kind, onSaved }: { kind: BulkKind; onSaved: (result: BulkSaveResult) => void }) {
  const toast = useToast()
  const copy = COPY[kind]
  const { profile, setProfile } = useLengthProfile()
  // The paste survives switching modes or pages in this window (sessionStorage; best effort).
  const storageKey = `axora.bulk.${kind}`
  const [raw, setRawState] = useState(() => {
    try {
      return sessionStorage.getItem(storageKey) ?? ''
    } catch {
      return ''
    }
  })
  const setRaw = (next: string) => {
    setRawState(next)
    try {
      if (next) sessionStorage.setItem(storageKey, next)
      else sessionStorage.removeItem(storageKey)
    } catch {
      // not critical
    }
  }
  /** The reviewed list once you edit or remove an item (null = exactly what the paste gives). */
  const [edits, setEdits] = useState<string[] | null>(null)
  const [target, setTarget] = useState('')
  const [saving, setSaving] = useState(false)
  const [lastResult, setLastResult] = useState<{ saved: number; skipped: { item: number; reason: string; text: string }[] } | null>(null)
  const savingRef = useRef(false)

  const parsed = useMemo(() => parseBulk(raw), [raw])
  const texts = edits ?? parsed.items.map((i) => i.text)
  const reviewed = useMemo(() => reviewItems(texts, kind, profile.id), [texts, kind, profile.id])
  const over = texts.length > BULK_MAX_ITEMS
  const valid = reviewed.filter((r) => !r.problems.some((p) => p.blocking) && r.duplicateOf === null).length
  const withProblems = reviewed.filter((r) => r.problems.some((p) => p.blocking)).length
  const repeats = reviewed.filter((r) => r.duplicateOf !== null).length

  // One request id per exact list (and settings): clicking again, or retrying after a lost reply, is the same request.
  const requestKey = JSON.stringify([kind, texts, profile.id, target.trim()])
  const request = useRef<{ key: string; id: string } | null>(null)
  const requestId = () => {
    if (request.current?.key !== requestKey) request.current = { key: requestKey, id: crypto.randomUUID() }
    return request.current.id
  }

  const setItem = (index: number, text: string) => setEdits(texts.map((t, i) => (i === index ? text : t)))
  const removeItem = (index: number) => setEdits(texts.filter((_, i) => i !== index))
  const clear = () => {
    setRaw('')
    setEdits(null)
    setLastResult(null)
  }

  const save = async () => {
    if (savingRef.current || over || valid === 0) return
    savingRef.current = true
    setSaving(true)
    try {
      const input = { requestId: requestId(), items: texts.map((text) => ({ text })), lengthProfile: profile.id, ...(kind === 'comment' ? { targetUrl: target.trim() || null } : {}) }
      const result = kind === 'post' ? await relay.drafts.saveMany(input) : await relay.comments.saveMany(input)
      const skipped = result.skipped.map((s) => ({ item: s.index + 1, reason: s.reason, text: texts[s.index] ?? '' }))
      // Items that can still be fixed stay in the list; saved ones, repeats and already-saved texts leave it.
      const fixable = result.skipped.filter((s) => !/^Same text as item|^Already saved/.test(s.reason)).map((s) => texts[s.index] ?? '')
      setLastResult({ saved: result.saved.length, skipped })
      if (fixable.length) setEdits(fixable)
      else {
        setRaw('')
        setEdits(null)
      }
      onSaved(result)
      const title = result.repeated ? `Already saved — ${copy.saved(result.saved.length).replace(' successfully', '')}` : copy.saved(result.saved.length)
      toast(
        skipped.length
          ? { tone: 'warning', title, description: `${pluralize(skipped.length, copy.noun[0], copy.noun[1])} not saved — see the list for the reasons.`, duration: 9000 }
          : { tone: 'success', title }
      )
    } catch (error) {
      // Nothing was saved (the save is one transaction): the pasted text and the list stay as they are.
      toast({ tone: 'danger', title: `${copy.noun[1][0]!.toUpperCase()}${copy.noun[1].slice(1)} not saved`, description: `${errorMessage(error)} Nothing was saved; your text is kept.`, duration: 10000 })
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const copyPrompt = () =>
    void navigator.clipboard
      .writeText(copy.prompt)
      .then(() => toast({ tone: 'success', title: 'Prompt copied', description: 'Paste it into ChatGPT, then paste the answer here.' }))
      .catch(() => toast({ tone: 'danger', title: 'Couldn’t copy', description: copy.prompt }))

  return (
    <Panel title={copy.title} description={`Paste up to ${BULK_MAX_ITEMS} ${copy.noun[1]} — for example a list written in ChatGPT — review them, and save them all at once.`}>
      <div className="flex flex-col gap-4">
        <details className="rounded-md border border-line bg-surface-1 px-3 py-2 text-sm" open={!raw}>
          <summary className="cursor-pointer text-fg">How to format the list</summary>
          <div className="mt-2 flex flex-col gap-2 text-xs text-fg-muted">
            <p>
              Number each {copy.noun[0]} (<code>1.</code>, <code>2.</code>, … — <code>1)</code> or <code>Post 1:</code> work too). A {copy.noun[0]} may span several lines; it ends where the next number starts. Without numbers, put one{' '}
              {copy.noun[0]} per line, or a blank line between {copy.noun[1]}. ChatGPT’s introduction and closing notes are left out; hashtags, @mentions, links and emojis are kept as written.
            </p>
            <pre className="whitespace-pre-wrap rounded border border-line bg-surface-2 px-2 py-1.5 font-mono text-[11px] text-fg" aria-label="Example">
              {copy.example}
            </pre>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="ghost" icon={ClipboardCopy} onClick={copyPrompt}>
                Copy a prompt for ChatGPT
              </Button>
              <span className="text-fg-subtle">Use ChatGPT in your browser, copy its answer, and paste it below. No AI service is called from here.</span>
            </div>
          </div>
        </details>

        <Field label={`Paste your ${copy.noun[1]}`} htmlFor={`bulk-${kind}`}>
          <Textarea
            id={`bulk-${kind}`}
            rows={10}
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value)
              setEdits(null)
              setLastResult(null)
            }}
            placeholder={copy.example}
            className="resize-y font-mono text-xs"
          />
        </Field>

        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl<'standard' | 'premium'>
            aria-label="Length limit"
            size="sm"
            value={profile.id}
            onChange={setProfile}
            options={[
              { value: 'standard', label: 'Up to 280' },
              { value: 'premium', label: 'Longer posts (X Premium)' }
            ]}
          />
          {kind === 'comment' && (
            <Input
              aria-label="Target post (optional)"
              placeholder="Target post link (optional) — or choose posts in the campaign"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              wrapperClassName="min-w-64 flex-1"
            />
          )}
        </div>

        {texts.length > 0 && (
          <div className="flex flex-col gap-1" aria-live="polite">
            <p className="flex flex-wrap items-center gap-2 text-sm text-fg" data-testid="bulk-count">
              <ListChecks size={15} className="text-accent-text" />
              <strong className="tabular font-semibold">{pluralize(texts.length, copy.noun[0], copy.noun[1])} detected</strong>
              {!edits && parsed.format !== 'empty' && <span className="text-xs text-fg-subtle">· {FORMAT_LABEL[parsed.format]}</span>}
              {edits && <span className="text-xs text-fg-subtle">· edited list</span>}
              {withProblems > 0 && <span className="text-xs text-danger">· {withProblems} to fix</span>}
              {repeats > 0 && <span className="text-xs text-warning">· {repeats} repeated (saved once)</span>}
            </p>
            {over && (
              <p role="alert" className="flex gap-2 text-xs text-danger">
                <CircleX size={13} className="mt-0.5 shrink-0" />
                Up to {BULK_MAX_ITEMS} {copy.noun[1]} per save — remove {texts.length - BULK_MAX_ITEMS}, or save them in two batches.
              </p>
            )}
            {!edits &&
              parsed.notes.map((n) => (
                <p key={n} className="flex gap-2 text-xs text-warning">
                  <TriangleAlert size={13} className="mt-0.5 shrink-0" />
                  {n}
                </p>
              ))}
            {!edits && parsed.ignored.length > 0 && (
              <details className="text-xs text-fg-subtle">
                <summary className="cursor-pointer">Left out: {pluralize(parsed.ignored.length, 'part')} that {parsed.ignored.length === 1 ? 'isn’t' : 'aren’t'} a {copy.noun[0]}</summary>
                <ul className="mt-1 flex flex-col gap-1" aria-label="Left out">
                  {parsed.ignored.map((g) => (
                    <li key={`${g.line}-${g.reason}`} className="truncate">
                      Line {g.line} · {g.reason}: <span className="text-fg-muted">{g.text.replace(/\s+/g, ' ')}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}

        {lastResult && lastResult.skipped.length > 0 && (
          <section aria-label="Save result" className="flex flex-col gap-1 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs">
            <p className="text-sm text-fg">
              {pluralize(lastResult.saved, copy.noun[0], copy.noun[1])} saved · {lastResult.skipped.length} not saved
            </p>
            <ul className="flex max-h-32 flex-col gap-0.5 overflow-y-auto">
              {lastResult.skipped.map((s) => (
                <li key={s.item} className="truncate text-fg-muted">
                  Item {s.item}: {s.reason} <span className="text-fg-subtle">— {s.text.replace(/\s+/g, ' ').slice(0, 80)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {texts.length > 0 && (
          <ol aria-label={`Detected ${copy.noun[1]}`} className="flex max-h-[28rem] flex-col divide-y divide-line overflow-y-auto rounded-md border border-line">
            {reviewed.map((r, i) => {
              const blocking = r.problems.find((p) => p.blocking)
              const weighted = measurePost(r.text.trim(), profile.maxWeighted).weighted
              return (
                <li key={i} className={cn('flex items-start gap-2 px-3 py-2', (blocking || i >= BULK_MAX_ITEMS) && 'bg-danger/5')}>
                  <span className="tabular w-7 shrink-0 pt-1.5 text-right text-xs text-fg-subtle">{i + 1}</span>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <Textarea
                      aria-label={`${copy.noun[0]} ${i + 1}`}
                      rows={Math.min(Math.max(r.text.split('\n').length, 1), 6)}
                      value={r.text}
                      invalid={Boolean(blocking)}
                      onChange={(e) => setItem(i, e.target.value)}
                      className="resize-y py-1.5 text-sm"
                    />
                    <p className="flex flex-wrap gap-x-3 text-xs">
                      <span className={cn('tabular', weighted > profile.maxWeighted ? 'text-danger' : 'text-fg-subtle')}>
                        {weighted.toLocaleString()} / {profile.maxWeighted.toLocaleString()}
                      </span>
                      {blocking && <span className="text-danger">{blocking.message}</span>}
                      {r.duplicateOf !== null && <span className="text-warning">Same text as {copy.noun[0]} {r.duplicateOf + 1} — saved once</span>}
                      {i >= BULK_MAX_ITEMS && <span className="text-danger">Over the {BULK_MAX_ITEMS} limit</span>}
                    </p>
                  </div>
                  <IconButton label={`Remove ${copy.noun[0]} ${i + 1}`} icon={X} size="sm" onClick={() => removeItem(i)} />
                </li>
              )
            })}
          </ol>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" icon={Save} loading={saving} disabled={over || valid === 0 || saving} onClick={() => void save()}>
            {copy.save}
            {valid > 0 ? ` (${valid})` : ''}
          </Button>
          {(raw || edits) && (
            <Button variant="ghost" icon={Eraser} onClick={clear} disabled={saving}>
              Clear
            </Button>
          )}
          {texts.length > 0 && valid < texts.length && !over && (
            <span className="text-xs text-fg-subtle">
              {valid} of {texts.length} will be saved{withProblems ? `; ${withProblems} with a problem stay in the list to fix` : ''}.
            </span>
          )}
        </div>
      </div>
    </Panel>
  )
}
