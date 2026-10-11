import { CalendarRange, Pause, PencilLine, Play, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import type { AutomationSchedule, AutomationScheduleInput } from '@shared/types/automation'
import { Button, ConfirmDialog, EmptyState, Field, IconButton, Input, Modal, PageHeader, Select, Skeleton, StatusBadge, useToast } from '@/components/ui'
import { useAutomationSchedules, usePresets } from '@/data/automation'
import { errorMessage, relay } from '@/lib/bridge'
import { formatDateTime } from '@/lib/format'
import { NAV_ITEMS } from '@/app/navigation'
import { loadDraftConfig } from './defaults'

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]
const pad = (n: number) => String(n).padStart(2, '0')
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const CURRENT = '__current__'

interface FormState {
  id?: string
  name: string
  source: string
  startDate: string
  endDate: string
  days: number[]
  windowStart: string
  windowEnd: string
}

const emptyForm = (): FormState => ({ name: '', source: CURRENT, startDate: today(), endDate: '', days: [1, 2, 3, 4, 5], windowStart: '09:00', windowEnd: '17:00' })

function daysLabel(days: number[]): string {
  if (days.length === 7) return 'Every day'
  if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) return 'Weekdays'
  if (days.length === 2 && days.includes(0) && days.includes(6)) return 'Weekends'
  return WEEK_ORDER.filter((d) => days.includes(d))
    .map((d) => DAY_NAMES[d])
    .join(', ')
}

/** Recurring automation: one run per chosen day inside the daily hours, between a start and an end date. */
export function SchedulesPage() {
  const toast = useToast()
  const navigate = useNavigate()
  const schedules = useAutomationSchedules()
  const presets = usePresets()
  const [form, setForm] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<AutomationSchedule | null>(null)

  const act = async (action: () => Promise<unknown>, success: string) => {
    try {
      await action()
      toast({ tone: 'success', title: success })
    } catch (e) {
      toast({ tone: 'danger', title: 'That didn’t work', description: errorMessage(e), duration: 8000 })
    } finally {
      schedules.reload()
    }
  }

  const edit = (s: AutomationSchedule) =>
    setForm({ id: s.id, name: s.name, source: s.presetId ?? CURRENT, startDate: s.startDate, endDate: s.endDate ?? '', days: s.days, windowStart: s.windowStart, windowEnd: s.windowEnd })

  const save = async () => {
    if (!form) return
    const existing = form.id ? schedules.data?.find((s) => s.id === form.id) : undefined
    const preset = form.source !== CURRENT ? presets.data?.find((p) => p.id === form.source) : undefined
    // Content comes from the chosen preset, or (kept as is when editing) the automation page's current settings.
    const config = preset?.config ?? (existing && form.source === (existing.presetId ?? CURRENT) ? existing.config : loadDraftConfig())
    const input: AutomationScheduleInput = {
      ...(form.id ? { id: form.id } : {}),
      name: form.name.trim(),
      config: { ...config, name: form.name.trim() || config.name },
      presetId: preset?.id ?? null,
      startDate: form.startDate,
      endDate: form.endDate || null,
      days: form.days,
      windowStart: form.windowStart,
      windowEnd: form.windowEnd
    }
    setSaving(true)
    try {
      await relay.automationSchedules.save(input)
      toast({ tone: 'success', title: form.id ? 'Schedule updated' : 'Schedule created' })
      setForm(null)
      schedules.reload()
    } catch (e) {
      toast({ tone: 'danger', title: 'Schedule not saved', description: errorMessage(e), duration: 9000 })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={NAV_ITEMS.schedules.label}
        description="Run an automation on chosen days and hours. Separate from the schedules of individual posts."
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setForm(emptyForm())}>
            New schedule
          </Button>
        }
      />
      <p className="text-xs text-fg-subtle">
        Each chosen day, X Auto starts one automation run and spreads its posts inside the daily hours (posts per profile = per day). Runs only start while X Auto is running — a day missed while it was
        closed is not made up later.
      </p>

      {!schedules.data ? (
        <Skeleton className="h-32" />
      ) : schedules.data.length === 0 ? (
        <EmptyState icon={CalendarRange} title="No automation schedules yet" description="Save your automation settings as a preset, then run them on chosen days and hours." />
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface-2" aria-label="Automation schedules">
          {schedules.data.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-fg">{s.name}</span>
                  <StatusBadge tone={s.status === 'active' ? 'success' : s.status === 'paused' ? 'warning' : 'neutral'} dot>
                    {s.status === 'active' ? 'Active' : s.status === 'paused' ? 'Paused' : 'Ended'}
                  </StatusBadge>
                </span>
                <span className="text-xs text-fg-subtle">
                  {daysLabel(s.days)} · {s.windowStart}–{s.windowEnd} · from {s.startDate}
                  {s.endDate ? ` to ${s.endDate}` : ', no end date'} · {s.config.mode === 'full-auto' ? 'Full Auto' : 'Manual Approval'}
                </span>
                <span className="text-xs text-fg-subtle">
                  {s.nextRunAt ? `Next: ${formatDateTime(s.nextRunAt)}` : s.status === 'active' ? 'No days left in the date range' : 'Not running'}
                  {s.lastRunId && (
                    <>
                      {' · '}
                      <button type="button" className="text-accent-text hover:underline" onClick={() => navigate(`/automation?run=${s.lastRunId}`)}>
                        last run ({s.lastRunDate})
                      </button>
                    </>
                  )}
                </span>
                {s.lastMessage && <span className="text-xs text-warning">{s.lastMessage}</span>}
              </span>
              <span className="flex items-center gap-1">
                {s.status === 'active' && (
                  <Button size="sm" icon={Pause} onClick={() => act(() => relay.automationSchedules.pause(s.id), 'Schedule paused')}>
                    Pause
                  </Button>
                )}
                {s.status === 'paused' && (
                  <Button size="sm" variant="primary" icon={Play} onClick={() => act(() => relay.automationSchedules.resume(s.id), 'Schedule resumed')}>
                    Resume
                  </Button>
                )}
                <IconButton icon={PencilLine} label="Edit schedule" size="sm" onClick={() => edit(s)} />
                <IconButton icon={Trash2} label="Delete schedule" size="sm" onClick={() => setDeleting(s)} />
              </span>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={form !== null}
        onClose={() => setForm(null)}
        dismissible={!saving}
        title={form?.id ? 'Edit schedule' : 'New automation schedule'}
        description="The posts, profiles, mode and limits come from a preset (or your current automation settings), copied when you save."
        footer={
          <>
            <Button variant="ghost" onClick={() => setForm(null)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" loading={saving} disabled={!form?.name.trim() || !form.days.length} onClick={save}>
              {form?.id ? 'Save schedule' : 'Create schedule'}
            </Button>
          </>
        }
      >
        {form && (
          <div className="flex flex-col gap-4">
            <Field label="Name" htmlFor="sched-name">
              <Input id="sched-name" value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Automation settings" htmlFor="sched-source">
              <Select<string>
                id="sched-source"
                value={form.source}
                onChange={(source) => setForm({ ...form, source })}
                options={[{ value: CURRENT, label: 'Current settings on the Automation page' }, ...(presets.data ?? []).map((p) => ({ value: p.id, label: `Preset: ${p.name}` }))]}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Start date" htmlFor="sched-start">
                <Input id="sched-start" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
              </Field>
              <Field label="End date (optional)" htmlFor="sched-end">
                <Input id="sched-end" type="date" value={form.endDate} min={form.startDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
              </Field>
            </div>
            <Field label="Days" htmlFor="sched-days">
              <div id="sched-days" role="group" aria-label="Days of the week" className="flex flex-wrap gap-1.5">
                {WEEK_ORDER.map((d) => {
                  const on = form.days.includes(d)
                  return (
                    <Button
                      key={d}
                      size="sm"
                      variant={on ? 'primary' : 'secondary'}
                      aria-pressed={on}
                      onClick={() => setForm({ ...form, days: on ? form.days.filter((x) => x !== d) : [...form.days, d] })}
                    >
                      {DAY_NAMES[d]}
                    </Button>
                  )
                })}
              </div>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Daily from" htmlFor="sched-from">
                <Input id="sched-from" type="time" value={form.windowStart} onChange={(e) => setForm({ ...form, windowStart: e.target.value })} />
              </Field>
              <Field label="Until" htmlFor="sched-until">
                <Input id="sched-until" type="time" value={form.windowEnd} onChange={(e) => setForm({ ...form, windowEnd: e.target.value })} />
              </Field>
            </div>
          </div>
        )}
      </Modal>
      <ConfirmDialog
        open={deleting !== null}
        title="Delete this schedule?"
        description="Runs it already started are kept. A run in progress continues; stop it on the Automation page if needed."
        confirmLabel="Delete"
        tone="danger"
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const target = deleting
          setDeleting(null)
          if (target) void act(() => relay.automationSchedules.remove(target.id), 'Schedule deleted')
        }}
      />
    </div>
  )
}
