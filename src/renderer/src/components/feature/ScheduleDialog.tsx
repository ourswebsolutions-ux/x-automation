import { CalendarClock, CircleX, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Id } from '@shared/types/domain'
import type { PublishCheck, ScheduleEntry } from '@shared/types/publishing'
import { Button, Modal, Spinner, useToast } from '@/components/ui'
import { errorMessage, relay } from '@/lib/bridge'
import { defaultTime, fromInputs, RunAtPicker, toDateInput, toTimeInput, whenLabel } from './RunAtPicker'

interface ScheduleDialogProps {
  open: boolean
  draftId: Id | null
  /** The schedule being changed. */
  entry: ScheduleEntry | null
  onClose: () => void
}

/**
 * Changes the time of a scheduled post (same account, same post). The publishing check runs
 * live, so blocking problems and warnings are visible before anything is saved.
 */
export function ScheduleDialog({ open, draftId, entry, onClose }: ScheduleDialogProps) {
  const toast = useToast()
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [check, setCheck] = useState<PublishCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const accountId = entry?.schedule.accountId ?? null

  useEffect(() => {
    if (!open) return
    const start = entry ? new Date(entry.schedule.runAt) : defaultTime()
    setDate(toDateInput(start))
    setTime(toTimeInput(start))
    setCheck(null)
  }, [open, entry])

  const runAt = fromInputs(date, time)
  const runAtIso = runAt?.toISOString()

  useEffect(() => {
    if (!open || !draftId) return
    if (!runAtIso) return setCheck(null)
    let live = true
    setChecking(true)
    const timer = setTimeout(() => {
      relay.publishing
        .check(draftId, accountId, runAtIso, entry?.schedule.id)
        .then((result) => live && setCheck(result))
        .catch((error: unknown) => live && setCheck({ ok: false, problems: [{ code: 'empty', message: errorMessage(error), blocking: true }] }))
        .finally(() => live && setChecking(false))
    }, 200)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [open, draftId, accountId, runAtIso, entry?.schedule.id])

  const blocking = check?.problems.filter((p) => p.blocking) ?? []
  const warnings = check?.problems.filter((p) => !p.blocking) ?? []
  const canSubmit = Boolean(entry && check?.ok && !checking && runAt)

  const submit = async () => {
    if (!canSubmit || !entry) return
    setSaving(true)
    try {
      const result = await relay.publishing.reschedule(entry.schedule.id, runAtIso!)
      toast({ tone: 'success', title: 'Schedule updated', description: whenLabel.format(new Date(result.schedule.runAt)) })
      onClose()
    } catch (error) {
      toast({ tone: 'danger', title: 'Not scheduled', description: errorMessage(error) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!saving}
      title="Change the time"
      description="When the time comes, X Auto opens the account’s IX Browser profile and posts it to X. The app needs to be running."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" icon={CalendarClock} disabled={!canSubmit} loading={saving} onClick={submit}>
            Save time
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <RunAtPicker
          idPrefix="schedule"
          date={date}
          time={time}
          onChange={(d, t) => {
            setDate(d)
            setTime(t)
          }}
        />
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
