import { CheckCheck, ExternalLink, ListTodo, MessageSquareReply, PencilLine, Play, RotateCw, Square, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import type { RunItem, RunStatus } from '@shared/types/automation'
import { Button, ConfirmDialog, IconButton, Skeleton, StatusBadge, useToast, type Tone } from '@/components/ui'
import { AssetThumb } from '@/components/feature/AssetThumb'
import { useRunDetails } from '@/data/automation'
import { errorMessage, relay } from '@/lib/bridge'
import { formatDateTime, pluralize } from '@/lib/format'

/** Campaign status in plain words: Running, Completed, Failed (Stopped / Paused for older or stopped runs). */
export const RUN_LABEL: Record<RunStatus, { label: string; tone: Tone; pulse?: boolean }> = {
  generating: { label: 'Running', tone: 'info', pulse: true },
  'awaiting-approval': { label: 'Waiting for approval', tone: 'warning' },
  publishing: { label: 'Running', tone: 'info', pulse: true },
  paused: { label: 'Paused', tone: 'warning' },
  completed: { label: 'Completed', tone: 'success' },
  stopped: { label: 'Stopped', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' }
}
const RUN_STATUS = RUN_LABEL

/** What an item looks like to the user (its publishing state comes from the queue). */
function itemState(i: RunItem): { label: string; tone: Tone } {
  if (i.kind === 'engagement') {
    const what = i.text?.startsWith('Repost') ? 'Repost' : i.text?.startsWith('Comment') ? 'Comment' : 'Task'
    if (i.engagementStatus === 'done') return { label: `${what} done`, tone: 'success' }
    if (i.engagementStatus === 'skipped') return { label: `${what} skipped`, tone: 'neutral' }
    return { label: `${what} task for you`, tone: 'neutral' }
  }
  switch (i.status) {
    case 'pending':
      return { label: 'Waiting', tone: 'neutral' }
    case 'generating':
      return { label: 'Generating', tone: 'info' }
    case 'awaiting-approval':
      return { label: 'Needs approval', tone: 'warning' }
    case 'saved':
      return { label: 'Saved as draft', tone: 'neutral' }
    case 'skipped':
      return { label: 'Skipped', tone: 'neutral' }
    case 'failed':
      return { label: 'Failed', tone: 'danger' }
    case 'removed':
      return { label: 'Removed', tone: 'neutral' }
    case 'scheduled':
      if (i.scheduleStatus === 'completed') return { label: 'Published', tone: 'success' }
      if (i.scheduleStatus === 'needs-review') return { label: 'Needs review', tone: 'warning' }
      if (i.scheduleStatus === 'failed') return { label: 'Failed', tone: 'danger' }
      if (i.scheduleStatus === 'cancelled') return { label: 'Cancelled', tone: 'neutral' }
      if (i.taskStatus === 'running') return { label: 'Publishing', tone: 'info' }
      return { label: 'Scheduled', tone: 'info' }
  }
}

/** The comment under a post: it waits for the post, then posts as a reply from the same account. */
function commentState(c: NonNullable<RunItem['comment']>, post: RunItem): { label: string; tone: Tone } {
  switch (c.status) {
    case 'succeeded':
      return { label: 'Comment posted', tone: 'success' }
    case 'running':
      return { label: 'Posting comment', tone: 'info' }
    case 'queued':
      return { label: 'Comment waiting', tone: 'info' }
    case 'failed':
      return { label: 'Comment failed', tone: 'danger' }
    case 'needs-review':
      return { label: 'Comment needs review', tone: 'warning' }
    case 'cancelled':
      return { label: 'Comment cancelled', tone: 'neutral' }
    default:
      return post.scheduleStatus === 'failed' || post.scheduleStatus === 'cancelled' || post.status === 'failed' || post.status === 'skipped'
        ? { label: 'Comment not posted', tone: 'neutral' }
        : { label: 'Comment after the post', tone: 'neutral' }
  }
}

/** Each selected post across all accounts: how many of its copies are published, waiting, publishing or failed. */
function PerPost({ items }: { items: RunItem[] }) {
  const groups = new Map<string, RunItem[]>()
  for (const i of items) if (i.kind === 'post' && i.sourceDraftId && i.status !== 'removed') groups.set(i.sourceDraftId, [...(groups.get(i.sourceDraftId) ?? []), i])
  if (groups.size === 0 || [...groups.values()].every((g) => g.length < 2)) return null
  return (
    <ul className="flex flex-col divide-y divide-line rounded-md border border-line" aria-label="Results per post">
      {[...groups.entries()].map(([id, group]) => {
        const label = (i: RunItem) => itemState(i).label
        const n = (l: string) => group.filter((i) => label(i) === l).length
        const failed = n('Failed') + n('Needs review')
        return (
          <li key={id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
            <span className="min-w-0 flex-1 truncate text-fg">{group[0]!.text ?? 'Post'}</span>
            <span className="tabular text-xs text-fg-subtle">
              Published on {n('Published')} of {group.length} {group.length === 1 ? 'account' : 'accounts'}
              {n('Publishing') ? ` · ${n('Publishing')} publishing` : ''}
              {n('Scheduled') + n('Waiting') ? ` · ${n('Scheduled') + n('Waiting')} waiting` : ''}
              {failed ? ` · ${failed} failed or to review` : ''}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/** A run: progress, Pause / Resume / Stop, mode switch, and every post with its preview. */
export function RunPanel({ runId }: { runId: string }) {
  const toast = useToast()
  const navigate = useNavigate()
  const details = useRunDetails(runId)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmStop, setConfirmStop] = useState(false)
  if (!details.data) return <Skeleton className="h-40" />
  const { run, items } = details.data
  const meta = RUN_STATUS[run.status]
  const c = run.counts
  const done = c.published + c.saved + c.failed + c.needsReview + c.skipped
  const live = ['generating', 'awaiting-approval', 'publishing', 'paused'].includes(run.status)
  const waiting = items.filter((i) => i.status === 'awaiting-approval')

  const act = async (name: string, action: () => Promise<unknown>, success?: string) => {
    setBusy(name)
    try {
      await action()
      if (success) toast({ tone: 'success', title: success })
    } catch (e) {
      toast({ tone: 'danger', title: 'That didn’t work', description: errorMessage(e), duration: 8000 })
    } finally {
      setBusy(null)
      details.reload()
    }
  }

  return (
    <section aria-label="Campaign status" className="flex flex-col gap-4 rounded-lg border border-line bg-surface-2 px-5 py-4">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-fg">{run.name}</h2>
          <StatusBadge tone={meta.tone} dot pulse={meta.pulse}>
            {meta.label}
          </StatusBadge>
        </span>
        <span className="text-xs text-fg-subtle">Started {formatDateTime(run.createdAt)}</span>
        {live && (
          <span className="ml-auto flex items-center gap-2">
            {run.status === 'paused' && (
              <Button size="sm" variant="primary" icon={Play} loading={busy === 'resume'} onClick={() => act('resume', () => relay.runs.resume(run.id))}>
                Resume
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={Square} onClick={() => setConfirmStop(true)}>
              Stop
            </Button>
          </span>
        )}
      </header>
      {run.message && <p className="text-xs text-warning">{run.message}</p>}

      <div className="flex flex-col gap-1.5">
        <div className="h-1.5 overflow-hidden rounded-full bg-surface-4" aria-hidden>
          <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${c.total ? Math.round((done / c.total) * 100) : 0}%` }} />
        </div>
        <span className="text-xs text-fg-subtle">
          {[
            c.published && `${c.published} published`,
            c.scheduled && `${c.scheduled} scheduled`,
            c.awaitingApproval && `${c.awaitingApproval} waiting for approval`,
            c.pending && `${c.pending} being prepared`,
            c.saved && `${c.saved} saved`,
            c.needsReview && `${c.needsReview} need review`,
            c.failed && `${c.failed} failed`,
            c.skipped && `${c.skipped} skipped`,
            c.comments.total && `comments: ${c.comments.posted} of ${c.comments.total} posted${c.comments.failed ? `, ${c.comments.failed} not posted` : ''}`
          ]
            .filter(Boolean)
            .join(' · ') || 'Getting ready…'}
        </span>
      </div>

      {waiting.length > 1 && (
        <Button size="sm" variant="primary" icon={CheckCheck} className="self-start" loading={busy === 'all'} onClick={() => act('all', () => relay.runs.approve(run.id, waiting.map((i) => i.id)), `${pluralize(waiting.length, 'post')} approved`)}>
          Approve all {waiting.length}
        </Button>
      )}

      <PerPost items={items} />

      <ul className="flex flex-col divide-y divide-line rounded-md border border-line" aria-label="Results per profile">
        {items
          .filter((i) => i.status !== 'removed')
          .map((i) => {
            const state = itemState(i)
            return (
              <li key={i.id} className="flex items-start gap-3 px-3 py-2.5">
                {i.imageAssetId ? (
                  <AssetThumb url={`relay-asset://asset/${i.imageAssetId}`} alt="Post image" available className="size-12 shrink-0 rounded-md" />
                ) : (
                  <span className="grid size-12 shrink-0 place-items-center rounded-md bg-surface-3 text-2xs text-fg-faint">{i.kind === 'engagement' ? <ListTodo size={16} /> : 'Text'}</span>
                )}
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="line-clamp-2 text-sm text-fg">{i.text || <span className="text-fg-faint">{i.status === 'generating' ? 'Writing…' : 'Not generated yet'}</span>}</span>
                  <span className="flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
                    <StatusBadge tone={state.tone} dot>
                      {state.label}
                    </StatusBadge>
                    {(i.profileName || i.accountLabel) && <span>{[i.profileName, i.accountLabel].filter(Boolean).join(' · ')}</span>}
                    {i.runAt && i.status !== 'saved' && <span>{formatDateTime(i.runAt)}</span>}
                    {i.image === 'skipped' && <span className="text-warning">no image</span>}
                    {i.fromDraft && <span>your draft</span>}
                  </span>
                  {i.error && <span className="text-xs text-fg-subtle">{i.error}</span>}
                  {i.comment && (
                    <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
                      <MessageSquareReply size={12} />
                      <StatusBadge tone={commentState(i.comment, i).tone} dot>
                        {commentState(i.comment, i).label}
                      </StatusBadge>
                      <span className="line-clamp-1 min-w-0 flex-1">{i.comment.text}</span>
                      {i.comment.url && (
                        <Button size="sm" variant="ghost" onClick={() => void relay.shell.openExternal(i.comment!.url!)}>
                          View comment
                        </Button>
                      )}
                    </span>
                  )}
                  {i.comment?.error && i.comment.status !== 'succeeded' && <span className="text-xs text-fg-subtle">{i.comment.error}</span>}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  {i.status === 'awaiting-approval' && (
                    <>
                      <Button size="sm" variant="secondary" icon={CheckCheck} loading={busy === `a:${i.id}`} onClick={() => act(`a:${i.id}`, () => relay.runs.approve(run.id, [i.id]), 'Approved')}>
                        Approve
                      </Button>
                      <IconButton icon={PencilLine} label="Edit" size="sm" onClick={() => i.draftId && navigate(`/create?draft=${i.draftId}`)} />
                      {!i.fromDraft && <IconButton icon={RotateCw} label="Regenerate" size="sm" onClick={() => act(`r:${i.id}`, () => relay.runs.regenerate(run.id, i.id), 'New version generated')} />}
                      <IconButton icon={Trash2} label="Remove" size="sm" onClick={() => act(`d:${i.id}`, () => relay.runs.remove(run.id, [i.id]))} />
                    </>
                  )}
                  {i.postUrl && <IconButton icon={ExternalLink} label="View on X" size="sm" onClick={() => void relay.shell.openExternal(i.postUrl!)} />}
                  {i.kind === 'engagement' && (
                    <Button size="sm" variant="ghost" onClick={() => navigate('/links?view=engagement')}>
                      Open tasks
                    </Button>
                  )}
                  {i.scheduleStatus === 'needs-review' && (
                    <Button size="sm" variant="ghost" onClick={() => document.getElementById('posting-queue')?.scrollIntoView({ behavior: 'smooth' })}>
                      Review
                    </Button>
                  )}
                </span>
              </li>
            )
          })}
      </ul>

      <ConfirmDialog
        open={confirmStop}
        title="Stop this automation?"
        description="Nothing more is generated, and posts and comments that haven’t started are cancelled (posts go back to your drafts). A post or comment being published right now finishes."
        confirmLabel="Stop"
        cancelLabel="Keep running"
        tone="danger"
        onCancel={() => setConfirmStop(false)}
        onConfirm={() => {
          setConfirmStop(false)
          void act('stop', () => relay.runs.stop(run.id))
        }}
      />
    </section>
  )
}
