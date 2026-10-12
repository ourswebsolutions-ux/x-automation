import { CalendarClock, CheckCircle2, CircleX, Clock, Loader2, MessageSquareReply, RefreshCw, Send, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import type { Id } from '@shared/types/domain'
import type { MultiScheduleResult, PublishAllCheck, ScheduleEntry, TaskView } from '@shared/types/publishing'
import { Button, Modal, SegmentedControl, Spinner, StatusBadge, Switch, useToast } from '@/components/ui'
import { errorMessage, relay } from '@/lib/bridge'
import { defaultTime, fromInputs, RunAtPicker, toDateInput, toTimeInput, whenLabel } from './RunAtPicker'

interface Props {
  open: boolean
  draftId: Id
  onClose: () => void
}

type When = 'now' | 'schedule'
const DONE = ['succeeded', 'failed', 'needs-review', 'cancelled']

/**
 * Publish now or schedule from Create Post. There is no account choice: the post goes out from
 * every synchronized profile that can post (decided by the main process), each with its own copy.
 * Posting the same text from several accounts has to be allowed explicitly. After sending, each
 * account's post — and its comment, when the post has one — is followed live.
 */
export function PublishDialog({ open, draftId, onClose }: Props) {
  const toast = useToast()
  const navigate = useNavigate()
  const [when, setWhen] = useState<When>('now')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [allowSame, setAllowSame] = useState(false)
  const [check, setCheck] = useState<PublishAllCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState<(MultiScheduleResult & { runAt: string | null }) | null>(null)
  const [tasks, setTasks] = useState<TaskView[]>([])
  const [syncing, setSyncing] = useState(false)
  const [refresh, setRefresh] = useState(0)

  // Reset only when the dialog opens — lists reload while publishing and must not reset it.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      const start = defaultTime()
      setWhen('now')
      setDate(toDateInput(start))
      setTime(toTimeInput(start))
      setAllowSame(false)
      setSent(null)
      setTasks([])
    }
    wasOpen.current = open
  }, [open])

  const runAt = when === 'schedule' ? fromInputs(date, time) : null
  const runAtIso = runAt?.toISOString()

  // Live check of the post against every eligible account.
  useEffect(() => {
    if (!open || sent) return
    if (when === 'schedule' && !runAtIso) return setCheck(null)
    let live = true
    setChecking(true)
    const timer = setTimeout(() => {
      relay.publishing
        .checkAll(draftId, runAtIso)
        .then((result) => live && setCheck(result))
        .catch((error: unknown) => live && setCheck({ ok: false, problems: [{ code: 'empty', message: errorMessage(error), blocking: true }], targets: { eligible: [], unavailable: [], profiles: 0 } }))
        .finally(() => live && setChecking(false))
    }, 200)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [open, draftId, when, runAtIso, sent, refresh])

  // After sending: follow each post's task (and its comment's) until it settles.
  useEffect(() => {
    if (!sent?.entries.length) return
    const drafts = new Set(sent.entries.map((e) => e.schedule.draftId))
    let live = true
    const poll = async () => {
      const list = await relay.queue.list({ view: 'all', limit: 300 })
      if (live) setTasks(list.filter((t) => (t.kind === 'publish' || t.kind === 'reply') && t.draftId && drafts.has(t.draftId)))
    }
    void poll()
    const timer = setInterval(() => void poll(), 2000)
    const off = relay.publishing.onChange(() => void poll())
    return () => {
      live = false
      clearInterval(timer)
      off()
    }
  }, [sent])

  const targets = check?.targets
  const eligible = targets?.eligible ?? []
  const blocking = check?.problems.filter((p) => p.blocking) ?? []
  const warnings = check?.problems.filter((p) => !p.blocking) ?? []
  const needsSame = eligible.length > 1
  const canSend = Boolean(check?.ok) && eligible.length > 0 && !checking && (!needsSame || allowSame) && !sending && (when === 'now' || Boolean(runAt))
  const label = (id: Id) => eligible.find((a) => a.accountId === id)?.label ?? 'Account'

  const sync = async () => {
    setSyncing(true)
    try {
      const run = await relay.ixbrowser.sync()
      toast({ tone: run.linkFailed ? 'warning' : 'success', title: 'Profiles synchronized', description: `${run.discovered} found · ${run.linked} newly linked${run.linkFailed ? ` · ${run.linkFailed} could not be linked` : ''}` })
      setRefresh((n) => n + 1)
    } catch (error) {
      toast({ tone: 'danger', title: 'Sync failed', description: errorMessage(error), duration: 9000 })
    } finally {
      setSyncing(false)
    }
  }

  const send = async () => {
    if (!canSend) return
    setSending(true)
    try {
      const result = await relay.publishing.publishAll({ draftId, runAt: runAtIso ?? null, allowSameText: allowSame })
      setSent({ ...result, runAt: runAtIso ?? null })
      const n = result.entries.length
      toast({
        tone: result.failed.length ? 'warning' : 'success',
        title: runAtIso ? `Scheduled on ${n} ${n === 1 ? 'profile' : 'profiles'}` : `Sent to the queue for ${n} ${n === 1 ? 'profile' : 'profiles'}`,
        description: result.failed.length ? `${result.failed.length} could not be sent: ${result.failed[0]!.reason}` : runAtIso ? whenLabel.format(new Date(runAtIso)) : undefined
      })
    } catch (error) {
      toast({ tone: 'danger', title: runAtIso ? 'Not scheduled' : 'Not published', description: errorMessage(error), duration: 9000 })
    } finally {
      setSending(false)
    }
  }

  const postOf = (entry: ScheduleEntry) => tasks.find((t) => t.kind === 'publish' && t.draftId === entry.schedule.draftId)
  const commentOf = (entry: ScheduleEntry) => tasks.find((t) => t.kind === 'reply' && t.draftId === entry.schedule.draftId)
  const scheduledLater = Boolean(sent?.runAt)
  const settled = sent && !scheduledLater && sent.entries.every((e) => DONE.includes(postOf(e)?.status ?? '') && (!commentOf(e) || DONE.includes(commentOf(e)!.status)))

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!sending}
      size="md"
      title={sent ? (scheduledLater ? 'Scheduled' : 'Publishing') : 'Publish'}
      description={
        sent
          ? scheduledLater
            ? `Goes out ${whenLabel.format(new Date(sent.runAt!))} from each profile below, while X Auto is running.`
            : settled
              ? 'Done — the results are below.'
              : 'X Auto opens each profile in IX Browser in turn and posts. You can close this window; publishing continues.'
          : 'The post goes out from every synchronized profile that can post — no account to choose. Each profile gets its own copy.'
      }
      footer={
        sent ? (
          <Button variant="primary" onClick={onClose}>
            {settled || scheduledLater ? 'Close' : 'Close (keeps publishing)'}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={sending}>
              Cancel
            </Button>
            <Button variant="primary" icon={when === 'now' ? Send : CalendarClock} disabled={!canSend} loading={sending} onClick={send}>
              {when === 'now' ? (eligible.length > 1 ? `Publish on ${eligible.length} profiles` : 'Publish now') : eligible.length > 1 ? `Schedule on ${eligible.length} profiles` : 'Schedule'}
            </Button>
          </>
        )
      }
    >
      {sent ? (
        <ul className="flex flex-col divide-y divide-line rounded-md border border-line" aria-label="Publishing progress">
          {sent.entries.map((entry) => {
            const t = postOf(entry)
            const c = commentOf(entry)
            const status = scheduledLater ? 'scheduled' : (t?.status ?? 'queued')
            return (
              <li key={entry.schedule.id} className="flex flex-col gap-1 px-3 py-2.5 text-sm">
                <span className="flex items-center gap-3">
                  <StatusIcon status={status} />
                  <span className="min-w-0 flex-1 truncate text-fg">{label(entry.schedule.accountId)}</span>
                  <span className="text-xs text-fg-subtle">{statusText(status, t, 'post')}</span>
                  {t?.result?.url && (
                    <Button size="sm" variant="ghost" onClick={() => void relay.shell.openExternal(t.result!.url!)}>
                      View on X
                    </Button>
                  )}
                </span>
                {c && (
                  <span className="flex items-center gap-3 pl-7 text-xs">
                    <MessageSquareReply size={13} className="text-fg-subtle" />
                    <span className="min-w-0 flex-1 text-fg-muted">Comment</span>
                    <span className="text-fg-subtle">{statusText(c.status, c, 'comment')}</span>
                    {c.result?.url && (
                      <Button size="sm" variant="ghost" onClick={() => void relay.shell.openExternal(c.result!.url!)}>
                        View
                      </Button>
                    )}
                  </span>
                )}
              </li>
            )
          })}
          {sent.failed.map((f) => (
            <li key={f.accountId} className="flex items-center gap-3 px-3 py-2.5 text-sm">
              <CircleX size={15} className="text-danger" />
              <span className="min-w-0 flex-1 truncate text-fg">{label(f.accountId)}</span>
              <span className="text-xs text-danger">{f.reason}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-col gap-4">
          <SegmentedControl<When>
            aria-label="When"
            value={when}
            onChange={setWhen}
            options={[
              { value: 'now', label: 'Publish now', icon: Send },
              { value: 'schedule', label: 'Schedule', icon: CalendarClock }
            ]}
            className="self-start"
          />
          {when === 'schedule' && (
            <RunAtPicker
              idPrefix="publish"
              date={date}
              time={time}
              onChange={(d, t) => {
                setDate(d)
                setTime(t)
              }}
            />
          )}

          <div className="flex flex-col gap-2 rounded-md border border-line px-3 py-2.5">
            <span className="flex items-center gap-2 text-sm text-fg" aria-live="polite">
              {targets ? (
                <span>
                  <strong className="tabular font-semibold">{eligible.length}</strong> of {targets.profiles} synchronized {targets.profiles === 1 ? 'profile' : 'profiles'} will post
                </span>
              ) : (
                <>
                  <Spinner size={12} /> Checking your profiles…
                </>
              )}
              <Button size="sm" variant="ghost" icon={RefreshCw} loading={syncing} onClick={sync} className="ml-auto">
                Sync profiles
              </Button>
            </span>
            {eligible.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {eligible.map((a) => (
                  <StatusBadge key={a.accountId} tone="neutral">
                    {a.handle ? `@${a.handle}` : a.label}
                  </StatusBadge>
                ))}
              </div>
            )}
            {(targets?.unavailable.length ?? 0) > 0 && (
              <p className="text-xs text-fg-subtle">
                Left out: {targets!.unavailable.map((u) => `${u.label} (${u.reason.toLowerCase()})`).join(', ')}
              </p>
            )}
            {targets && targets.profiles === 0 && (
              <Button size="sm" variant="secondary" className="self-start" onClick={() => navigate('/accounts?view=profiles')}>
                Open Synchronized Profiles
              </Button>
            )}
          </div>

          {needsSame && (
            <div className="flex flex-col gap-2 rounded-md bg-warning-soft px-3 py-2">
              <p className="flex gap-2 text-xs text-warning">
                <TriangleAlert size={13} className="mt-0.5 shrink-0" />
                The same text from several accounts can be treated by X as repeated or coordinated content. Each profile gets its own copy of this post (and of its comment).
              </p>
              <label className="flex items-center gap-2 text-xs text-fg-muted">
                <Switch checked={allowSame} onChange={setAllowSame} aria-label="Post the same text from several accounts" />
                Post the same text from {eligible.length} accounts
              </label>
            </div>
          )}
          <div aria-live="polite" className="flex min-h-5 flex-col gap-1.5">
            {checking && check && (
              <span className="flex items-center gap-2 text-xs text-fg-subtle">
                <Spinner size={12} /> Checking…
              </span>
            )}
            {blocking.map((b) => (
              <p key={b.message} role="alert" className="flex gap-2 text-xs text-danger">
                <CircleX size={13} className="mt-0.5 shrink-0" />
                {b.message}
              </p>
            ))}
            {warnings.map((w) => (
              <p key={w.message} className="flex gap-2 text-xs text-warning">
                <TriangleAlert size={13} className="mt-0.5 shrink-0" />
                {w.message}
              </p>
            ))}
          </div>
        </div>
      )}
    </Modal>
  )
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'succeeded') return <CheckCircle2 size={15} className="text-success" />
  if (status === 'failed' || status === 'cancelled') return <CircleX size={15} className="text-danger" />
  if (status === 'needs-review') return <TriangleAlert size={15} className="text-warning" />
  if (status === 'scheduled') return <Clock size={15} className="text-info" />
  return <Loader2 size={15} className="animate-spin text-info" />
}

function statusText(status: string, t: TaskView | undefined, noun: 'post' | 'comment'): string {
  switch (status) {
    case 'scheduled':
      return 'Scheduled'
    case 'succeeded':
      return noun === 'post' ? 'Published' : 'Posted'
    case 'failed':
      return t?.error ?? 'Failed'
    case 'needs-review':
      return 'Needs a review in Campaigns'
    case 'running':
      return t?.stage ?? (noun === 'post' ? 'Publishing…' : 'Posting…')
    case 'cancelled':
      return 'Cancelled'
    default:
      return noun === 'post' ? 'Waiting in the queue' : 'Waiting for its turn'
  }
}
