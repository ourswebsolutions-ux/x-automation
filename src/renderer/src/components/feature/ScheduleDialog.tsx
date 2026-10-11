import { CalendarClock, CircleX, Send, TriangleAlert, UsersRound } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Account } from '@shared/types/accounts'
import type { Id } from '@shared/types/domain'
import type { PublishCheck, ScheduleEntry } from '@shared/types/publishing'
import { Button, Checkbox, Field, Input, Modal, Select, Spinner, Switch, useToast } from '@/components/ui'
import { errorMessage, relay } from '@/lib/bridge'

export type ScheduleMode = 'schedule' | 'publish-now' | 'reschedule'

interface ScheduleDialogProps {
  open: boolean
  mode: ScheduleMode
  draftId: Id | null
  /** Pre-selected account (the draft's). */
  accountId: Id | null
  accounts: Account[]
  /** The schedule being changed (reschedule). */
  entry?: ScheduleEntry | null
  onClose: () => void
  onDone?: (entry: ScheduleEntry | null) => void
}

const pad = (n: number) => String(n).padStart(2, '0')
const toDateInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const toTimeInput = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const fromInputs = (date: string, time: string): Date | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null
  const value = new Date(`${date}T${time}:00`)
  return Number.isNaN(value.getTime()) ? null : value
}
/** The next quarter hour at least an hour from now. */
const defaultTime = () => {
  const d = new Date(Date.now() + 60 * 60_000)
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0)
  return d
}
const whenLabel = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
})

function quickPicks(): { label: string; at: Date }[] {
  const now = new Date()
  const picks: { label: string; at: Date }[] = [{ label: 'In 1 hour', at: new Date(now.getTime() + 60 * 60_000) }]
  const evening = new Date(now)
  evening.setHours(18, 0, 0, 0)
  if (evening.getTime() - now.getTime() > 30 * 60_000) picks.push({ label: 'This evening, 18:00', at: evening })
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  tomorrow.setHours(9, 0, 0, 0)
  picks.push({ label: 'Tomorrow, 09:00', at: tomorrow })
  return picks
}

/**
 * Schedule a draft, change a schedule's time, or publish right away. The
 * publishing check runs live, so blocking problems and warnings are visible
 * before anything is submitted.
 */
export function ScheduleDialog({ open, mode, draftId, accountId: initialAccount, accounts, entry, onClose, onDone }: ScheduleDialogProps) {
  const toast = useToast()
  const [accountId, setAccountId] = useState<Id | null>(initialAccount)
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [check, setCheck] = useState<PublishCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  // Extra accounts for the same post (each gets its own copy of the draft).
  const [showExtra, setShowExtra] = useState(false)
  const [extra, setExtra] = useState<Id[]>([])
  const [allowSame, setAllowSame] = useState(false)

  useEffect(() => {
    if (!open) return
    const start = entry ? new Date(entry.schedule.runAt) : defaultTime()
    setAccountId(entry?.schedule.accountId ?? initialAccount)
    setDate(toDateInput(start))
    setTime(toTimeInput(start))
    setCheck(null)
    setShowExtra(false)
    setExtra([])
    setAllowSame(false)
  }, [open, entry, initialAccount])

  const runAt = mode === 'publish-now' ? null : fromInputs(date, time)
  const runAtIso = runAt?.toISOString()

  useEffect(() => {
    if (!open || !draftId) return
    if (mode !== 'publish-now' && !runAtIso) return setCheck(null)
    let live = true
    setChecking(true)
    const timer = setTimeout(() => {
      relay.publishing
        .check(draftId, accountId, runAtIso, entry?.schedule.id)
        .then((result) => live && setCheck(result))
        .catch(
          (error: unknown) =>
            live &&
            setCheck({
              ok: false,
              problems: [{ code: 'empty', message: errorMessage(error), blocking: true }]
            })
        )
        .finally(() => live && setChecking(false))
    }, 200)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [open, draftId, accountId, runAtIso, mode, entry?.schedule.id])

  const account = accounts.find((a) => a.id === accountId) ?? null
  const blocking = check?.problems.filter((p) => p.blocking) ?? []
  const warnings = check?.problems.filter((p) => !p.blocking) ?? []
  const extras = extra.filter((id) => id !== accountId)
  const canSubmit = Boolean(draftId && accountId && check?.ok && !checking && (mode === 'publish-now' || runAt) && (extras.length === 0 || allowSame))
  const picks = useMemo(() => (open ? quickPicks() : []), [open])

  const submit = async () => {
    if (!canSubmit || !draftId || !accountId) return
    setSaving(true)
    try {
      if (extras.length && mode !== 'reschedule') {
        const many = await relay.publishing.scheduleMany({
          draftId,
          accountIds: [accountId, ...extras],
          runAt: mode === 'publish-now' ? null : runAtIso!,
          allowSameText: allowSame
        })
        const n = many.entries.length
        toast({
          tone: many.failed.length ? 'warning' : 'success',
          title: mode === 'publish-now' ? `Sent to the queue for ${n} ${n === 1 ? 'account' : 'accounts'}` : `Scheduled from ${n} ${n === 1 ? 'account' : 'accounts'}`,
          description: many.failed.length ? `${many.failed.length} could not be scheduled: ${many.failed[0]!.reason}` : mode === 'publish-now' ? undefined : whenLabel.format(runAt!)
        })
        onDone?.(many.entries[0] ?? null)
        onClose()
        return
      }
      const result =
        mode === 'publish-now'
          ? await relay.publishing.publishNow({ draftId, accountId })
          : mode === 'reschedule' && entry
            ? await relay.publishing.reschedule(entry.schedule.id, runAtIso!)
            : await relay.publishing.schedule({
                draftId,
                accountId,
                runAt: runAtIso!
              })
      toast(
        mode === 'publish-now'
          ? {
              tone: 'success',
              title: 'Sent to the queue',
              description: `It will be posted from ${account?.label ?? 'the account'} shortly.`
            }
          : {
              tone: 'success',
              title: mode === 'reschedule' ? 'Schedule updated' : 'Post scheduled',
              description: whenLabel.format(new Date(result.schedule.runAt))
            }
      )
      onDone?.(result)
      onClose()
    } catch (error) {
      toast({
        tone: 'danger',
        title: mode === 'publish-now' ? 'Not sent' : 'Not scheduled',
        description: errorMessage(error)
      })
    } finally {
      setSaving(false)
    }
  }

  const title = mode === 'publish-now' ? 'Publish now' : mode === 'reschedule' ? 'Change the time' : 'Schedule post'
  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!saving}
      title={title}
      description={
        mode === 'publish-now'
          ? 'X Auto opens the account’s IX Browser profile and posts this to X as soon as the queue reaches it.'
          : 'When the time comes, X Auto opens the account’s IX Browser profile and posts it to X. The app needs to be running.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" icon={mode === 'publish-now' ? Send : CalendarClock} disabled={!canSubmit} loading={saving} onClick={submit}>
            {mode === 'publish-now' ? 'Publish now' : mode === 'reschedule' ? 'Save time' : 'Schedule'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {mode !== 'reschedule' && (
          <Field label="Account" htmlFor="schedule-account">
            <Select<string>
              id="schedule-account"
              value={accountId}
              placeholder="Choose an account"
              onChange={setAccountId}
              options={accounts.map((a) => ({
                value: a.id,
                label: a.label,
                description: a.handle ? `@${a.handle}` : 'Username not set',
                disabled: !a.enabled
              }))}
            />
          </Field>
        )}
        {mode !== 'reschedule' && accounts.length > 1 && (
          <div className="flex flex-col gap-2">
            {!showExtra ? (
              <Button size="sm" variant="ghost" icon={UsersRound} className="self-start" onClick={() => setShowExtra(true)}>
                Also post from other accounts
              </Button>
            ) : (
              <>
                <span className="text-xs font-medium text-fg-muted">Also post from</span>
                <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-md border border-line p-2" aria-label="Other accounts">
                  {accounts
                    .filter((a) => a.id !== accountId)
                    .map((a) => (
                      <li key={a.id} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={extra.includes(a.id)}
                          disabled={!a.enabled}
                          onChange={(on) => setExtra(on ? [...new Set([...extra, a.id])] : extra.filter((x) => x !== a.id))}
                          aria-label={`Also post from ${a.label}`}
                        />
                        <span className="min-w-0 flex-1 truncate text-fg">{a.label}</span>
                        <span className="text-xs text-fg-subtle">{a.handle ? `@${a.handle}` : 'Username not set'}</span>
                      </li>
                    ))}
                </ul>
                {extras.length > 0 && (
                  <div className="flex flex-col gap-2 rounded-md bg-warning-soft px-3 py-2">
                    <p className="flex gap-2 text-xs text-warning">
                      <TriangleAlert size={13} className="mt-0.5 shrink-0" />
                      The same text from several accounts can be treated by X as repeated or coordinated content. Each account gets its own copy of this draft.
                    </p>
                    <label className="flex items-center gap-2 text-xs text-fg-muted">
                      <Switch checked={allowSame} onChange={setAllowSame} aria-label="Post the same text from several accounts" />
                      Post the same text from {extras.length + 1} accounts
                    </label>
                  </div>
                )}
              </>
            )}
          </div>
        )}
        {mode !== 'publish-now' && (
          <>
            <div className="grid grid-cols-[minmax(0,1fr)_140px] gap-3">
              <Field label="Date" htmlFor="schedule-date">
                <Input id="schedule-date" type="date" value={date} min={toDateInput(new Date())} onChange={(e) => setDate(e.target.value)} />
              </Field>
              <Field label="Time" htmlFor="schedule-time">
                <Input id="schedule-time" type="time" value={time} step={300} onChange={(e) => setTime(e.target.value)} />
              </Field>
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick picks">
              {picks.map((p) => (
                <Button
                  key={p.label}
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDate(toDateInput(p.at))
                    setTime(toTimeInput(p.at))
                  }}
                >
                  {p.label}
                </Button>
              ))}
            </div>
            {runAt && <p className="text-xs text-fg-subtle">Goes out {whenLabel.format(runAt)} (this computer’s time).</p>}
          </>
        )}
        <div aria-live="polite" className="flex min-h-5 flex-col gap-1.5">
          {checking && !check && (
            <span className="flex items-center gap-2 text-xs text-fg-subtle">
              <Spinner size={12} /> Checking…
            </span>
          )}
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
      </div>
    </Modal>
  )
}
