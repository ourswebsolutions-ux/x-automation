import { CircleX, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Account } from '@shared/types/accounts'
import type { EngagementCheck, EngagementKind, EngagementTaskView } from '@shared/types/links'
import { Button, Field, Input, Modal, Select, Switch, Textarea, useToast } from '@/components/ui'
import { errorMessage, relay } from '@/lib/bridge'
import { pluralize } from '@/lib/format'
import { ENGAGEMENT_KIND } from './engagementMeta'

interface EngagementDialogProps {
  open: boolean
  /** Create tasks for these links… */
  linkIds?: string[]
  /** …or edit this task. */
  task?: EngagementTaskView | null
  accounts: Account[]
  onClose: () => void
}

const pad = (n: number) => String(n).padStart(2, '0')
const dateOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const timeOf = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const KINDS = Object.keys(ENGAGEMENT_KIND) as EngagementKind[]

/** Plan (or edit) an engagement task. The guardrails are checked as you choose. */
export function EngagementDialog({ open, linkIds = [], task, accounts, onClose }: EngagementDialogProps) {
  const toast = useToast()
  const editing = Boolean(task)
  const [kind, setKind] = useState<EngagementKind>('reply')
  const [accountId, setAccountId] = useState<string | null>(null)
  const [hasDue, setHasDue] = useState(false)
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [note, setNote] = useState('')
  const [replyText, setReplyText] = useState('')
  const [checks, setChecks] = useState<EngagementCheck[] | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    const due = task?.dueAt ? new Date(task.dueAt) : new Date(Date.now() + 60 * 60_000)
    setKind(task?.kind ?? 'reply')
    setAccountId(task?.accountId ?? accounts.find((a) => a.enabled)?.id ?? null)
    setHasDue(Boolean(task?.dueAt))
    setDate(dateOf(due))
    setTime(timeOf(due))
    setNote(task?.note ?? '')
    setReplyText(task?.replyText ?? '')
    setChecks(null)
  }, [open, task, accounts])

  const dueAt = hasDue && date && time ? new Date(`${date}T${time}:00`).toISOString() : null
  const fields = { accountId, kind, dueAt, note, replyText }

  useEffect(() => {
    if (!open || editing || !linkIds.length) return
    let live = true
    const timer = setTimeout(() => {
      relay.engagement
        .check({ linkIds, ...fields })
        .then((r) => live && setChecks(r))
        .catch(() => live && setChecks(null))
    }, 200)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [open, editing, linkIds.join(','), accountId, kind, dueAt])

  const okCount = checks?.filter((c) => c.ok).length ?? 0
  const blocking = [...new Map((checks ?? []).flatMap((c) => c.problems.filter((p) => p.blocking)).map((p) => [p.code, p])).values()]
  const warnings = [...new Map((checks ?? []).flatMap((c) => c.problems.filter((p) => !p.blocking)).map((p) => [p.code, p])).values()]
  const canSave = editing || (checks !== null && okCount > 0)
  const showReply = kind === 'reply' || kind === 'quote'

  const save = async () => {
    setSaving(true)
    try {
      if (task) {
        await relay.engagement.update(task.id, fields)
        toast({ tone: 'success', title: 'Task updated' })
        onClose()
      } else {
        const r = await relay.engagement.create({ linkIds, ...fields })
        toast({
          tone: r.skipped.length ? 'warning' : 'success',
          title: `${pluralize(r.created.length, 'task')} planned`,
          description: r.skipped.length ? `${pluralize(r.skipped.length, 'link')} skipped — ${r.skipped[0]!.reason}` : undefined,
          duration: r.skipped.length ? 9000 : 4000
        })
        if (r.created.length) onClose()
      }
    } catch (error) {
      toast({ tone: 'danger', title: editing ? 'Not updated' : 'Not planned', description: errorMessage(error), duration: 9000 })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!saving}
      title={editing ? 'Edit task' : linkIds.length > 1 ? `Plan a task for ${linkIds.length} posts` : 'Plan a task'}
      description="A reminder of something you will do yourself. X Auto never likes, reposts, replies or follows on its own."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!canSave} onClick={save}>
            {editing ? 'Save task' : linkIds.length > 1 && checks ? `Plan ${pluralize(okCount, 'task')}` : 'Plan task'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="What" htmlFor="engagement-kind">
            <Select<EngagementKind> id="engagement-kind" value={kind} onChange={setKind} options={KINDS.map((k) => ({ value: k, label: ENGAGEMENT_KIND[k].label, icon: ENGAGEMENT_KIND[k].icon }))} />
          </Field>
          <Field label="Account" htmlFor="engagement-account">
            <Select<string>
              id="engagement-account"
              value={accountId ?? 'none'}
              onChange={(v) => setAccountId(v === 'none' ? null : v)}
              options={[{ value: 'none', label: 'No account' }, ...accounts.map((a) => ({ value: a.id, label: a.label, description: a.handle ? `@${a.handle}` : a.enabled ? undefined : 'Disabled' }))]}
            />
          </Field>
        </div>
        <label className="flex items-center justify-between gap-3">
          <span className="text-sm text-fg">Due</span>
          <Switch checked={hasDue} onChange={setHasDue} aria-label="Set a due time" />
        </label>
        {hasDue && (
          <div className="grid grid-cols-[minmax(0,1fr)_140px] gap-3">
            <Input aria-label="Due date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <Input aria-label="Due time" type="time" value={time} step={300} onChange={(e) => setTime(e.target.value)} />
          </div>
        )}
        {showReply && (
          <Field label={kind === 'quote' ? 'Quote text' : 'Reply text'} htmlFor="engagement-reply" aside={<span className="text-2xs text-fg-faint">Optional · you post it yourself</span>}>
            <Textarea id="engagement-reply" rows={3} value={replyText} maxLength={4000} onChange={(e) => setReplyText(e.target.value)} />
          </Field>
        )}
        <Field label="Note" htmlFor="engagement-note" aside={<span className="text-2xs text-fg-faint">Optional</span>}>
          <Textarea id="engagement-note" rows={2} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {!editing && (
          <div aria-live="polite" className="flex flex-col gap-1.5">
            {linkIds.length > 1 && checks && <p className="text-xs text-fg-subtle">{okCount === checks.length ? `All ${checks.length} posts can be planned.` : `${okCount} of ${checks.length} posts can be planned.`}</p>}
            {blocking.map((p) => (
              <p key={p.code} role="alert" className="flex gap-2 text-xs text-danger">
                <CircleX size={13} className="mt-0.5 shrink-0" />
                {p.message}
              </p>
            ))}
            {warnings.map((p) => (
              <p key={p.code} className="flex gap-2 text-xs text-warning">
                <TriangleAlert size={13} className="mt-0.5 shrink-0" />
                {p.message}
              </p>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}
