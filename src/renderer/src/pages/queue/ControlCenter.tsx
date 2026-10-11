import { CalendarClock, Pause, Play, Square } from 'lucide-react'
import { useState } from 'react'
import type { AutomationSnapshot } from '@shared/types/publishing'
import { Button, ConfirmDialog, Skeleton, StatusBadge, useToast } from '@/components/ui'
import { errorMessage, relay } from '@/lib/bridge'
import { formatDateTime, formatRelative, pluralize } from '@/lib/format'

const STATE: Record<AutomationSnapshot['state'], { label: string; tone: 'success' | 'neutral' | 'warning' }> = {
  running: { label: 'Running', tone: 'success' },
  idle: { label: 'Ready', tone: 'neutral' },
  paused: { label: 'Paused', tone: 'warning' }
}

/** Start/pause/stop for everything the queue runs, and what it is doing right now. */
export function ControlCenter({ snapshot, onChange }: { snapshot: AutomationSnapshot | undefined; onChange: () => void }) {
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmStop, setConfirmStop] = useState(false)
  if (!snapshot) return <Skeleton className="h-24" />
  const s = snapshot
  const meta = STATE[s.state]
  const waiting = s.counts.queued - s.counts.held

  const act = async (name: string, action: () => Promise<unknown>, title: string, description?: string) => {
    setBusy(name)
    try {
      await action()
      toast({ tone: name === 'pause' || name === 'stop' ? 'info' : 'success', title, description })
    } catch (error) {
      toast({ tone: 'danger', title: 'That didn’t work', description: errorMessage(error) })
    } finally {
      setBusy(null)
      onChange()
    }
  }

  return (
    <section aria-label="Automation controls" className="flex flex-col gap-3 rounded-lg border border-line bg-surface-2 px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="flex items-center gap-2 text-sm font-medium text-fg">
          Automation
          <StatusBadge tone={meta.tone} dot pulse={s.state === 'running'}>
            {meta.label}
          </StatusBadge>
        </span>
        <span className="text-xs text-fg-subtle">
          {s.state === 'paused' && s.pausedAt ? `Paused ${formatRelative(s.pausedAt)} — scheduled posts wait in the queue.` : s.state === 'running' ? 'Publishing one post at a time.' : waiting ? `${pluralize(waiting, 'task')} waiting for its time.` : 'Nothing waiting.'}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {s.state === 'paused' ? (
            <Button size="sm" variant="primary" icon={Play} loading={busy === 'resume'} onClick={() => act('resume', () => relay.control.resume(), 'Automation resumed')}>
              Resume
            </Button>
          ) : (
            <Button size="sm" icon={Pause} loading={busy === 'pause'} onClick={() => act('pause', () => relay.control.pause(), 'Automation paused', s.current ? 'The current post finishes first.' : undefined)}>
              Pause
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={Square} disabled={!s.current} onClick={() => setConfirmStop(true)}>
            Stop now
          </Button>
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 border-t border-line pt-3 text-xs @3xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.3fr)]">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-2xs font-medium uppercase tracking-[0.06em] text-fg-faint">Now</span>
          {s.current ? (
            <>
              <span className="truncate text-sm text-fg">{s.current.draftPreview || s.current.label}</span>
              <span className="truncate text-fg-subtle">
                {[s.current.accountLabel, s.current.profileName ? `profile ${s.current.profileName}` : null, s.current.stage].filter(Boolean).join(' · ')}
              </span>
            </>
          ) : (
            <span className="text-fg-subtle">Nothing running</span>
          )}
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-2xs font-medium uppercase tracking-[0.06em] text-fg-faint">Today</span>
          <span className="text-fg-muted">
            {s.today.succeeded} done{s.today.failed ? ` · ${s.today.failed} need attention` : ''}
          </span>
          <span className="text-fg-subtle">
            {waiting} waiting{s.counts.held ? ` · ${s.counts.held} on hold` : ''}
          </span>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-2xs font-medium uppercase tracking-[0.06em] text-fg-faint">Next scheduled</span>
          {s.next ? (
            <span className="flex min-w-0 items-center gap-1.5 text-fg-muted">
              <CalendarClock size={12} className="shrink-0 text-fg-subtle" />
              <span className="truncate">
                {formatDateTime(s.next.schedule.runAt)} · {s.next.account?.label ?? 'account'}
              </span>
            </span>
          ) : (
            <span className="text-fg-subtle">Nothing scheduled</span>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirmStop}
        title="Stop automation now?"
        description="Automation pauses, and the running post stops before it is submitted if it hasn’t been already — it goes back into the queue. A post already being submitted can’t be called back."
        confirmLabel="Stop now"
        cancelLabel="Keep running"
        tone="danger"
        onCancel={() => setConfirmStop(false)}
        onConfirm={() => {
          setConfirmStop(false)
          void act('stop', () => relay.control.stopNow(), 'Automation stopped', 'Resume when you’re ready.')
        }}
      />
    </section>
  )
}
