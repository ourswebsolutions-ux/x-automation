import { useMemo } from 'react'
import { Button, Field, Input } from '@/components/ui'

const pad = (n: number) => String(n).padStart(2, '0')
export const toDateInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const toTimeInput = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
/** Local date and time inputs → the moment they mean on this computer (converted to UTC when sent). */
export const fromInputs = (date: string, time: string): Date | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null
  const value = new Date(`${date}T${time}:00`)
  return Number.isNaN(value.getTime()) ? null : value
}
/** The next quarter hour at least an hour from now. */
export const defaultTime = () => {
  const d = new Date(Date.now() + 60 * 60_000)
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0)
  return d
}
export const whenLabel = new Intl.DateTimeFormat(undefined, {
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

/** Date and time (this computer's time zone) with quick picks. */
export function RunAtPicker({ date, time, onChange, idPrefix = 'run-at' }: { date: string; time: string; onChange: (date: string, time: string) => void; idPrefix?: string }) {
  const picks = useMemo(() => quickPicks(), [])
  const runAt = fromInputs(date, time)
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-[minmax(0,1fr)_140px] gap-3">
        <Field label="Date" htmlFor={`${idPrefix}-date`}>
          <Input id={`${idPrefix}-date`} type="date" value={date} min={toDateInput(new Date())} onChange={(e) => onChange(e.target.value, time)} />
        </Field>
        <Field label="Time" htmlFor={`${idPrefix}-time`}>
          <Input id={`${idPrefix}-time`} type="time" value={time} step={300} onChange={(e) => onChange(date, e.target.value)} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick picks">
        {picks.map((p) => (
          <Button key={p.label} size="sm" variant="ghost" onClick={() => onChange(toDateInput(p.at), toTimeInput(p.at))}>
            {p.label}
          </Button>
        ))}
      </div>
      {runAt && <p className="text-xs text-fg-subtle">Goes out {whenLabel.format(runAt)} (this computer’s time).</p>}
    </div>
  )
}
