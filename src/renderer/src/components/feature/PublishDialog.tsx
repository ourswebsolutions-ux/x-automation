import { CheckCircle2, CircleX, Loader2, Send, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Account } from '@shared/types/accounts'
import type { Id } from '@shared/types/domain'
import type { PublishProblem, ScheduleEntry, TaskView } from '@shared/types/publishing'
import { Button, Checkbox, Modal, SegmentedControl, Spinner, StatusBadge, Switch, useToast } from '@/components/ui'
import { errorMessage, relay } from '@/lib/bridge'

interface Props {
  open: boolean
  draftId: Id
  /** The post's own account, preselected under "Select accounts". */
  defaultAccountId: Id | null
  accounts: Account[]
  onClose: () => void
}

type Scope = 'all' | 'selected'

/** Why an account can't publish right now (null = it can). */
function unusable(a: Account): string | null {
  if (!a.enabled) return 'Disabled for tasks'
  if (!a.profile) return 'No IX Browser profile linked'
  if (a.profile.availability === 'unavailable') return 'Profile not reported by IX Browser'
  return null
}

/**
 * Publish now from Create Post: to all accounts or the ones you pick. Every account is checked
 * first; posting the same text from several accounts has to be allowed explicitly. After sending,
 * each account's progress is followed live until it is published, failed or needs a review.
 */
export function PublishDialog({ open, draftId, defaultAccountId, accounts, onClose }: Props) {
  const toast = useToast()
  const usable = useMemo(() => accounts.filter((a) => !unusable(a)), [accounts])
  const [scope, setScope] = useState<Scope>('all')
  const [picked, setPicked] = useState<Id[]>([])
  const [allowSame, setAllowSame] = useState(false)
  const [checks, setChecks] = useState<Record<Id, PublishProblem[]>>({})
  const [checking, setChecking] = useState(false)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState<{ entries: ScheduleEntry[]; failed: { accountId: Id; reason: string }[] } | null>(null)
  const [tasks, setTasks] = useState<TaskView[]>([])

  // Reset only when the dialog opens — account lists reload while publishing and must not reset it.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      const own = defaultAccountId && usable.some((a) => a.id === defaultAccountId)
      setScope(own ? 'selected' : 'all')
      setPicked(own ? [defaultAccountId!] : [])
      setAllowSame(false)
      setSent(null)
      setTasks([])
    }
    wasOpen.current = open
  }, [open, defaultAccountId, usable])

  const targets = scope === 'all' ? usable.map((a) => a.id) : picked.filter((id) => usable.some((a) => a.id === id))
  const key = targets.join(',')

  // Live check of the post against every target account.
  useEffect(() => {
    if (!open || sent || !targets.length) return setChecks({})
    let live = true
    setChecking(true)
    const timer = setTimeout(() => {
      void Promise.all(targets.map(async (id) => [id, (await relay.publishing.check(draftId, id)).problems] as const))
        .then((pairs) => live && setChecks(Object.fromEntries(pairs)))
        .catch(() => live && setChecks({}))
        .finally(() => live && setChecking(false))
    }, 200)
    return () => {
      live = false
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key, draftId, sent])

  // After sending: follow each post's task until it settles.
  useEffect(() => {
    if (!sent?.entries.length) return
    const drafts = new Set(sent.entries.map((e) => e.schedule.draftId))
    let live = true
    const poll = async () => {
      const list = await relay.queue.list({ view: 'all', limit: 200 })
      if (live) setTasks(list.filter((t) => t.kind === 'publish' && t.draftId && drafts.has(t.draftId)))
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

  const blocking = Object.entries(checks).flatMap(([id, problems]) => problems.filter((p) => p.blocking).map((p) => ({ id, message: p.message })))
  const warnings = [...new Set(Object.values(checks).flatMap((problems) => problems.filter((p) => !p.blocking).map((p) => p.message)))]
  const needsSame = targets.length > 1
  const canSend = targets.length > 0 && !checking && blocking.length === 0 && (!needsSame || allowSame) && !sending
  const label = (id: Id) => accounts.find((a) => a.id === id)?.label ?? 'Account'

  const send = async () => {
    if (!canSend) return
    setSending(true)
    try {
      const result = await relay.publishing.scheduleMany({ draftId, accountIds: targets, runAt: null, allowSameText: allowSame })
      setSent(result)
      toast({
        tone: result.failed.length ? 'warning' : 'success',
        title: `Sent to the queue for ${result.entries.length} ${result.entries.length === 1 ? 'account' : 'accounts'}`,
        description: result.failed.length ? `${result.failed.length} could not be sent: ${result.failed[0]!.reason}` : undefined
      })
    } catch (error) {
      toast({ tone: 'danger', title: 'Not published', description: errorMessage(error), duration: 9000 })
    } finally {
      setSending(false)
    }
  }

  const progressOf = (entry: ScheduleEntry) => tasks.find((t) => t.draftId === entry.schedule.draftId)
  const settled = sent && sent.entries.every((e) => ['succeeded', 'failed', 'needs-review', 'cancelled'].includes(progressOf(e)?.status ?? ''))

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!sending}
      size="md"
      title={sent ? 'Publishing' : 'Publish now'}
      description={sent ? (settled ? 'Done — the results are below.' : 'X Auto opens each account’s IX Browser profile in turn and posts. You can close this window; publishing continues.') : 'Choose the accounts. X Auto opens each account’s IX Browser profile and posts this to X, one account at a time.'}
      footer={
        sent ? (
          <Button variant="primary" onClick={onClose}>
            {settled ? 'Close' : 'Close (keeps publishing)'}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={sending}>
              Cancel
            </Button>
            <Button variant="primary" icon={Send} disabled={!canSend} loading={sending} onClick={send}>
              {targets.length > 1 ? `Publish to ${targets.length} accounts` : 'Publish now'}
            </Button>
          </>
        )
      }
    >
      {sent ? (
        <ul className="flex flex-col divide-y divide-line rounded-md border border-line" aria-label="Publishing progress">
          {sent.entries.map((entry) => {
            const t = progressOf(entry)
            const status = t?.status ?? 'queued'
            return (
              <li key={entry.schedule.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                {status === 'succeeded' ? <CheckCircle2 size={15} className="text-success" /> : status === 'failed' || status === 'cancelled' ? <CircleX size={15} className="text-danger" /> : status === 'needs-review' ? <TriangleAlert size={15} className="text-warning" /> : <Loader2 size={15} className="animate-spin text-info" />}
                <span className="min-w-0 flex-1 truncate text-fg">{label(entry.schedule.accountId ?? '')}</span>
                <span className="text-xs text-fg-subtle">
                  {status === 'succeeded' ? 'Published' : status === 'failed' ? (t?.error ?? 'Failed') : status === 'needs-review' ? 'Needs a review in Campaign Automation' : status === 'running' ? (t?.stage ?? 'Publishing…') : status === 'cancelled' ? 'Cancelled' : 'Waiting in the queue'}
                </span>
                {t?.result?.url && (
                  <Button size="sm" variant="ghost" onClick={() => void relay.shell.openExternal(t.result!.url!)}>
                    View on X
                  </Button>
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
          <SegmentedControl<Scope>
            aria-label="Accounts"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'all', label: 'All accounts' },
              { value: 'selected', label: 'Select accounts' }
            ]}
          />
          <span className="text-xs text-fg-subtle" aria-live="polite">
            {targets.length} of {accounts.length} {accounts.length === 1 ? 'account' : 'accounts'} selected · {usable.length} can publish
          </span>
          {scope === 'selected' && (
            <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-md border border-line p-2" aria-label="Accounts to publish from">
              {accounts.map((a) => {
                const reason = unusable(a)
                return (
                  <li key={a.id} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={picked.includes(a.id)} disabled={Boolean(reason)} onChange={(on) => setPicked(on ? [...new Set([...picked, a.id])] : picked.filter((x) => x !== a.id))} aria-label={`Publish from ${a.label}`} />
                    <span className="min-w-0 flex-1 truncate text-fg">{a.label}</span>
                    <span className="text-xs text-fg-subtle">{reason ?? (a.handle ? `@${a.handle}` : 'Username not set')}</span>
                  </li>
                )
              })}
            </ul>
          )}
          {targets.length === 0 && <p className="text-xs text-danger">{usable.length === 0 ? 'No account can publish yet — link accounts to IX Browser profiles in Accounts & Profiles.' : 'Choose at least one account.'}</p>}
          {needsSame && (
            <div className="flex flex-col gap-2 rounded-md bg-warning-soft px-3 py-2">
              <p className="flex gap-2 text-xs text-warning">
                <TriangleAlert size={13} className="mt-0.5 shrink-0" />
                The same text from several accounts can be treated by X as repeated or coordinated content. Each account gets its own copy of this post.
              </p>
              <label className="flex items-center gap-2 text-xs text-fg-muted">
                <Switch checked={allowSame} onChange={setAllowSame} aria-label="Post the same text from several accounts" />
                Post the same text from {targets.length} accounts
              </label>
            </div>
          )}
          <div aria-live="polite" className="flex min-h-5 flex-col gap-1.5">
            {checking && (
              <span className="flex items-center gap-2 text-xs text-fg-subtle">
                <Spinner size={12} /> Checking…
              </span>
            )}
            {blocking.map((b) => (
              <p key={`${b.id}:${b.message}`} role="alert" className="flex gap-2 text-xs text-danger">
                <CircleX size={13} className="mt-0.5 shrink-0" />
                {label(b.id)}: {b.message}
              </p>
            ))}
            {warnings.map((w) => (
              <p key={w} className="flex gap-2 text-xs text-warning">
                <TriangleAlert size={13} className="mt-0.5 shrink-0" />
                {w}
              </p>
            ))}
          </div>
          {scope === 'all' && usable.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {usable.map((a) => (
                <StatusBadge key={a.id} tone="neutral">
                  {a.label}
                </StatusBadge>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
