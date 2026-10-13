import { Bot, Copy, Eraser, MessageSquareReply, RotateCcw, Save, Sparkles, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { composePost, LENGTH_PROFILE_LIST, type LengthProfileId } from '@shared/config/postLimits'
import { commentProblems, NO_COMMENT } from '@shared/lib/postComment'
import type { Draft, MediaAttachment, PostComment } from '@shared/types/domain'
import type { ImageAsset } from '@shared/types/images'
import { Button, ConfirmDialog, Field, IconButton, KeyCombo, SegmentedControl, Select, StatusBadge, Switch, Textarea, Tooltip, useToast } from '@/components/ui'
import { AssetLibraryDialog, importSummary } from '@/components/feature/AssetLibraryDialog'
import { errorMessage, relay } from '@/lib/bridge'
import { HashtagInput } from '@/components/feature/HashtagInput'
import { LengthMeter } from '@/components/feature/LengthMeter'
import { PostPreview } from '@/components/feature/PostPreview'
import { useLengthProfile } from '@/data/drafts'
import { MOD_LABEL, useHotkey } from '@/hooks/useHotkey'
import { cn } from '@/lib/cn'
import { formatRelative } from '@/lib/format'
import { measurePost } from '@/lib/postLength'
import { AssistPanel } from './AssistPanel'
import { AttachmentsBar, mediaProblems, slotsLeft, toAttachment } from './AttachmentsBar'
import { ImagePanel } from './ImagePanel'
import { PublishActions, PublishStatus } from './PublishBar'

export interface EditorValue {
  body: string
  hashtags: string[]
  status: 'draft' | 'ready'
  aiAssisted: boolean
  sourceGenerationId: string | null
  /** Attached images in order (descriptions included). */
  media: MediaAttachment[]
  /** Posted as a reply to this post by each account that posts it. */
  comment: PostComment
}

interface DraftEditorProps {
  /** The saved draft being edited, or null for a new one. */
  draft: Draft | null
  saving: boolean
  onSave: (value: EditorValue) => void
  onSaveAsNew: (value: EditorValue) => Promise<void>
  onDuplicate: () => void
  onDelete: () => void
  onDirtyChange: (dirty: boolean) => void
}

const fromDraft = (draft: Draft | null): EditorValue => ({
  body: draft?.body ?? '',
  hashtags: draft?.hashtags ?? [],
  status: draft?.status === 'ready' ? 'ready' : 'draft',
  aiAssisted: false,
  sourceGenerationId: draft?.sourceGenerationId ?? null,
  media: draft?.media ?? [],
  comment: draft?.comment ?? NO_COMMENT
})

const mediaKey = (media: MediaAttachment[]) => media.map((m) => `${m.id}:${m.altText}`).join('\u0000')
const same = (a: EditorValue, b: EditorValue) =>
  a.body === b.body &&
  a.status === b.status &&
  a.hashtags.join('\u0000') === b.hashtags.join('\u0000') &&
  mediaKey(a.media) === mediaKey(b.media) &&
  a.comment.enabled === b.comment.enabled &&
  a.comment.text === b.comment.text

/** The writing area for one draft. Nothing is saved until the user saves. */
export function DraftEditor(props: DraftEditorProps) {
  const { draft } = props
  const { profile, setProfile } = useLengthProfile()
  const saved = useMemo(() => fromDraft(draft), [draft])
  const [value, setValue] = useState<EditorValue>(saved)
  const toast = useToast()
  const [assistOpen, setAssistOpen] = useState(false)
  const [imageOpen, setImageOpen] = useState(false)
  const [library, setLibrary] = useState<{ replaceIndex: number | null } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [confirm, setConfirm] = useState<'clear' | 'reset' | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Load another draft (or a fresh one) when the selection changes.
  useEffect(() => {
    setValue(fromDraft(draft))
    setAssistOpen(false)
    setImageOpen(false)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [draft?.id])

  // Status changes come from saving or from publishing (scheduled, failed, back to drafts):
  // either way the saved draft is the truth. Reset during render, so no render sees the old
  // value against the new draft (that briefly looked like unsaved changes).
  const [statusSeen, setStatusSeen] = useState(draft?.status)
  if (draft?.status !== statusSeen) {
    setStatusSeen(draft?.status)
    setValue(fromDraft(draft))
  }

  const editable = !draft || draft.status === 'draft' || draft.status === 'ready'
  // A draft that became scheduled/published (possibly while open) has nothing unsaved.
  const dirty = editable && draft?.status === statusSeen && !same(value, saved)
  const { onDirtyChange } = props
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])

  const composed = composePost(value.body, value.hashtags)
  const length = useMemo(() => measurePost(composed, profile.maxWeighted), [composed, profile.maxWeighted])
  const empty = !value.body.trim() && value.hashtags.length === 0 && value.media.length === 0
  const problems = mediaProblems(value.media)
  const mediaInvalid = Boolean(problems.set) || Object.keys(problems.byId).length > 0
  const comment = commentProblems(value.comment)
  const commentBlocked = comment.some((p) => p.blocking)
  const commentLength = useMemo(() => measurePost(value.comment.text.trim(), profile.maxWeighted), [value.comment.text, profile.maxWeighted])
  const canSave = editable && !empty && !mediaInvalid && !commentBlocked && (dirty || !draft) && !props.saving

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 160), 420)}px`
  }, [value.body])

  const set = (patch: Partial<EditorValue>) => setValue((v) => ({ ...v, ...patch }))
  const attach = (assets: ImageAsset[]) =>
    setValue((v) => {
      const fresh = assets.filter((a) => !v.media.some((m) => m.id === a.id)).map((a) => toAttachment(a))
      return { ...v, media: [...v.media, ...fresh].slice(0, 4) }
    })
  const replaceAt = (index: number, asset: ImageAsset) =>
    setValue((v) => ({ ...v, media: v.media.map((m, i) => (i === index ? toAttachment(asset, m.altText) : m)).filter((m, i, all) => all.findIndex((x) => x.id === m.id) === i) }))
  const upload = async () => {
    setUploading(true)
    try {
      const result = await relay.assets.import()
      if (result.cancelled) return
      toast(importSummary(result))
      attach([...result.imported, ...result.existing].slice(0, slotsLeft(value.media)))
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not add images', description: errorMessage(error) })
    } finally {
      setUploading(false)
    }
  }
  const save = () => canSave && props.onSave(value)
  // Works wherever focus is on the page (e.g. after reordering images moves focus).
  useHotkey('mod+s', () => void save(), { allowInInputs: true })

  return (
    <section
      aria-label={draft ? 'Edit draft' : 'New draft'}
      className="flex min-w-0 flex-col rounded-lg border border-line bg-surface-2"
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault()
          save()
        }
      }}
    >
      <header className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2">
        <h2 className="text-sm font-medium text-fg">{draft ? 'Edit draft' : 'New draft'}</h2>
        {draft?.origin === 'ai' && (
          <StatusBadge tone="accent" icon={Bot}>
            AI-assisted
          </StatusBadge>
        )}
        <span className={cn('text-xs', dirty ? 'text-warning' : 'text-fg-subtle')} aria-live="polite">
          {dirty ? 'Unsaved changes' : draft ? `Saved ${formatRelative(draft.updatedAt)}` : 'Not saved yet'}
        </span>
        <span className="flex-1" />
        {draft && (
          <>
            <IconButton icon={Copy} label={dirty ? 'Duplicate (saved version)' : 'Duplicate'} size="sm" onClick={props.onDuplicate} />
            <IconButton icon={Trash2} label="Delete draft" size="sm" onClick={props.onDelete} />
          </>
        )}
      </header>

      {!editable && draft && <PublishStatus draft={draft} />}

      <div className="flex flex-col gap-3 px-4 py-3.5">
        <h3 className="text-2xs font-medium uppercase tracking-[0.07em] text-fg-faint">Post</h3>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl<'draft' | 'ready'>
            size="sm"
            disabled={!editable}
            value={value.status}
            onChange={(status) => set({ status })}
            options={[
              { value: 'draft', label: 'Draft' },
              { value: 'ready', label: 'Ready' }
            ]}
          />
          <span className="flex-1" />
          <Tooltip content={profile.description}>
            <span>
              <Select<LengthProfileId>
                size="sm"
                className="w-48"
                aria-label="Length limit"
                value={profile.id}
                onChange={setProfile}
                options={LENGTH_PROFILE_LIST.map((p) => ({ value: p.id, label: p.label }))}
              />
            </span>
          </Tooltip>
        </div>

        <Textarea
          ref={textareaRef}
          value={value.body}
          disabled={!editable}
          placeholder="What do you want to say?"
          aria-label="Post text"
          invalid={length.isOver}
          onChange={(e) => set({ body: e.target.value })}
          className="min-h-40 text-base"
        />

        <section aria-label="Comment" className="flex flex-col gap-2.5 rounded-md border border-line bg-surface-1/40 px-3.5 py-3">
          <div className="flex items-center gap-2">
            <MessageSquareReply size={14} className="text-fg-subtle" />
            <h3 className="text-sm font-medium text-fg">Comment</h3>
            <span className="text-xs text-fg-subtle">Optional · posted as a reply to this post</span>
            <span className="flex-1" />
            <Switch
              checked={value.comment.enabled}
              disabled={!editable}
              onChange={(enabled) => set({ comment: { ...value.comment, enabled } })}
              aria-label="Post a comment under this post"
            />
          </div>
          {value.comment.enabled && (
            <>
              <Textarea
                value={value.comment.text}
                disabled={!editable}
                rows={3}
                placeholder="Add a comment to your post (for example a link or more detail)"
                aria-label="Comment text"
                invalid={commentBlocked}
                onChange={(e) => set({ comment: { ...value.comment, text: e.target.value } })}
              />
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 text-xs text-fg-subtle">
                  Each profile that posts this replies to its own post with this comment, right after X confirms the post. It is never posted on anyone else’s post.
                </span>
                <LengthMeter length={commentLength} />
              </div>
              {comment.map((p) => (
                <p key={p.code} role={p.blocking ? 'alert' : undefined} className={cn('text-xs', p.blocking ? 'text-danger' : 'text-warning')}>
                  {p.message}
                </p>
              ))}
            </>
          )}
        </section>

        <Field label="Hashtags" htmlFor="draft-hashtags" hint="Added on their own line when posted, unless the text already contains them.">
          <HashtagInput id="draft-hashtags" value={value.hashtags} disabled={!editable} onChange={(hashtags) => set({ hashtags })} />
        </Field>

        <AttachmentsBar
          media={value.media}
          disabled={!editable}
          uploading={uploading}
          onChange={(media) => set({ media })}
          onUpload={upload}
          onLibrary={() => setLibrary({ replaceIndex: null })}
          onGenerate={() => setImageOpen(true)}
          onReplace={(index) => setLibrary({ replaceIndex: index })}
        />

        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant={assistOpen ? 'secondary' : 'ghost'} icon={Sparkles} disabled={!editable} onClick={() => setAssistOpen((o) => !o)} aria-expanded={assistOpen}>
            AI assist
          </Button>
          <span className="min-w-0 flex-1 px-2 text-xs text-danger">
            {length.isOver &&
              (profile.id === 'standard'
                ? `${-length.remaining} over the 280 limit — it can be saved, but not posted as-is.`
                : `${-length.remaining} over the longer-post limit.`)}
            {!length.isOver && profile.id === 'premium' && length.weighted > 280 && (
              <span className="text-fg-subtle">Over 280 — only accounts with X Premium can post this.</span>
            )}
          </span>
          <LengthMeter length={length} />
        </div>
      </div>

      {imageOpen && (
        <ImagePanel
          postText={composed}
          draftId={draft?.id ?? null}
          slotsLeft={slotsLeft(value.media)}
          onAttach={(asset) => {
            attach([asset])
            toast({ tone: 'success', title: 'Image attached', description: 'Save the draft to keep it.' })
          }}
          onClose={() => setImageOpen(false)}
        />
      )}

      {assistOpen && (
        <AssistPanel
          text={value.body}
          hashtags={value.hashtags}
          draftId={draft?.id ?? null}
          profile={profile}
          onReplace={(text, generationId) => set({ body: text, aiAssisted: true, sourceGenerationId: generationId })}
          onAddHashtags={(tags) => set({ hashtags: [...value.hashtags, ...tags.filter((t) => !value.hashtags.some((h) => h.toLowerCase() === t.toLowerCase()))].slice(0, 30), aiAssisted: true })}
          onSaveAsDraft={(text, generationId) => props.onSaveAsNew({ ...value, body: text, aiAssisted: true, sourceGenerationId: generationId, status: 'draft' })}
          onClose={() => setAssistOpen(false)}
        />
      )}

      <div className="flex flex-col gap-2 border-t border-line px-4 py-3.5">
        <span className="text-2xs font-medium uppercase tracking-[0.07em] text-fg-faint">Preview</span>
        <PostPreview text={composed} name="Your account" handle={null} media={value.media} />
        {value.comment.enabled && value.comment.text.trim() && (
          <div className="ml-6 flex flex-col gap-1 border-l-2 border-line pl-3">
            <span className="text-2xs font-medium uppercase tracking-[0.07em] text-fg-faint">Comment (reply)</span>
            <PostPreview text={value.comment.text.trim()} name="Your account" handle={null} media={[]} />
          </div>
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-2 rounded-b-lg border-t border-line bg-surface-1/50 px-4 py-2.5">
        <span className="mr-auto flex items-center gap-1.5 text-xs text-fg-subtle">
          <KeyCombo keys={[MOD_LABEL, 'S']} /> to save
        </span>
        {/* Stays mounted after publishing starts (the post is then locked) so the progress dialog remains open. */}
        {draft && <PublishActions draft={draft} dirty={dirty} editable={editable} />}
        {draft && editable && <span className="mx-1 h-5 w-px bg-line" aria-hidden />}
        <Button size="sm" variant="ghost" icon={Eraser} disabled={!editable || empty} onClick={() => setConfirm('clear')}>
          Clear
        </Button>
        <Button size="sm" variant="ghost" icon={RotateCcw} disabled={!dirty} onClick={() => setConfirm('reset')}>
          Reset
        </Button>
        <Button size="sm" variant="primary" icon={Save} disabled={!canSave} loading={props.saving} onClick={save}>
          {draft ? 'Save changes' : 'Save draft'}
        </Button>
      </footer>

      <AssetLibraryDialog
        open={Boolean(library)}
        onClose={() => setLibrary(null)}
        maxPick={library?.replaceIndex !== null && library?.replaceIndex !== undefined ? 1 : Math.max(slotsLeft(value.media), 0)}
        pickLabel={library?.replaceIndex !== null && library?.replaceIndex !== undefined ? 'Replace' : 'Attach'}
        onPick={(assets) => {
          if (library?.replaceIndex !== null && library?.replaceIndex !== undefined && assets[0]) replaceAt(library.replaceIndex, assets[0])
          else attach(assets)
          setLibrary(null)
        }}
      />
      <ConfirmDialog
        open={confirm !== null}
        title={confirm === 'clear' ? 'Clear the text, hashtags and images?' : 'Discard your changes?'}
        description={
          confirm === 'clear'
            ? draft
              ? 'The editor is emptied, including the comment. Nothing is saved until you save — Reset brings back the saved version.'
              : 'Everything you typed in this new draft is removed.'
            : 'The editor goes back to the last saved version of this draft.'
        }
        confirmLabel={confirm === 'clear' ? 'Clear' : 'Discard changes'}
        tone="danger"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm === 'clear') set({ body: '', hashtags: [], media: [], comment: NO_COMMENT })
          else setValue(saved)
          setConfirm(null)
        }}
      />
    </section>
  )
}
