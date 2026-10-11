import { ArrowRight, Pause, Play, Square, Workflow } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Button, ConfirmDialog, StatusBadge, useToast } from '@/components/ui'
import { useActiveRun, usePresets } from '@/data/automation'
import { useAsync } from '@/hooks/useAsync'
import { errorMessage, relay } from '@/lib/bridge'
import { formatNumber, formatRelative } from '@/lib/format'
import { useNotifications } from '@/state/notifications'

/**
 * The dashboard's automation strip: the current run with Pause / Resume / Stop,
 * or "Create automation" with saved presets — plus today's AI usage and the
 * latest notifications.
 */
export function AutomationPanel() {
  const navigate = useNavigate()
  const toast = useToast()
  const active = useActiveRun()
  const presets = usePresets()
  const { items } = useNotifications()
  const [busy, setBusy] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)
  const today = new Date()
  const usage = useAsync(
    () => relay.usage.report({ from: new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString(), to: new Date().toISOString() }),
    [today.getDate()]
  )
  const run = active.data
  const c = run?.counts
  const done = c ? c.published + c.saved + c.failed + c.needsReview + c.skipped : 0

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await action()
    } catch (e) {
      toast({ tone: 'danger', title: 'That didn’t work', description: errorMessage(e) })
    } finally {
      setBusy(false)
      active.reload()
    }
  }

  return (
    <section aria-label="Automation" className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-line bg-line @4xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-3 bg-surface-2 px-5 py-4">
        <div className="flex items-center gap-2">
          <Workflow size={15} className="text-accent-text" />
          <h2 className="text-sm font-medium text-fg">Automation</h2>
          {run && (
            <StatusBadge tone={run.status === 'paused' || run.status === 'awaiting-approval' ? 'warning' : 'info'} dot pulse={run.status === 'generating' || run.status === 'publishing'}>
              {run.status === 'awaiting-approval' ? 'Waiting for approval' : run.status === 'generating' ? 'Preparing posts' : run.status === 'publishing' ? 'Publishing' : 'Paused'}
            </StatusBadge>
          )}
        </div>
        {run && c ? (
          <>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm text-fg">{run.name}</span>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-4" aria-hidden>
                <div className="h-full rounded-full bg-accent" style={{ width: `${c.total ? Math.round((done / c.total) * 100) : 0}%` }} />
              </div>
              <span className="text-xs text-fg-subtle">
                {c.published} of {c.total} published{c.awaitingApproval ? ` · ${c.awaitingApproval} waiting for approval` : ''}
                {c.needsReview ? ` · ${c.needsReview} need review` : ''}
                {c.failed ? ` · ${c.failed} failed` : ''}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {run.status === 'paused' ? (
                <Button size="sm" variant="primary" icon={Play} loading={busy} onClick={() => act(() => relay.runs.resume(run.id))}>
                  Resume
                </Button>
              ) : (
                <Button size="sm" icon={Pause} loading={busy} onClick={() => act(() => relay.runs.pause(run.id))}>
                  Pause
                </Button>
              )}
              <Button size="sm" variant="ghost" icon={Square} onClick={() => setConfirmStop(true)}>
                Stop
              </Button>
              <Button size="sm" variant="ghost" trailingIcon={ArrowRight} onClick={() => navigate(`/automation?run=${run.id}`)}>
                Open
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-fg-muted">Describe the posts you want, choose profiles, and start once — X Auto writes, illustrates and publishes them.</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="primary" icon={Workflow} onClick={() => navigate('/automation')}>
                Create automation
              </Button>
              {(presets.data ?? []).slice(0, 3).map((p) => (
                <Button key={p.id} size="sm" variant="ghost" onClick={() => navigate(`/automation?preset=${p.id}`)}>
                  {p.name}
                </Button>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="flex flex-col gap-3 bg-surface-2 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-2xs font-medium uppercase tracking-[0.06em] text-fg-faint">AI usage today</span>
          <span className="text-sm text-fg-muted">
            {usage.data
              ? `${formatNumber(usage.data.totals.requests)} requests · ${formatNumber(usage.data.totals.totalTokens)} tokens · ${formatNumber(usage.data.totals.images)} images${usage.data.totals.estimatedCost !== null ? ` · ~$${usage.data.totals.estimatedCost.toFixed(2)} (estimate)` : ''}`
              : '—'}
          </span>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-2xs font-medium uppercase tracking-[0.06em] text-fg-faint">Recent notifications</span>
          {items.length === 0 ? (
            <span className="text-xs text-fg-subtle">None yet.</span>
          ) : (
            items.slice(0, 3).map((n) => (
              <button key={n.id} type="button" className="flex min-w-0 items-baseline gap-2 text-left text-xs hover:text-fg" onClick={() => n.to && navigate(n.to)}>
                <span className={n.tone === 'danger' ? 'text-danger' : n.tone === 'warning' ? 'text-warning' : n.tone === 'success' ? 'text-success' : 'text-fg-muted'}>●</span>
                <span className="min-w-0 flex-1 truncate text-fg-muted">{n.title}</span>
                <span className="shrink-0 text-2xs text-fg-faint">{formatRelative(n.at)}</span>
              </button>
            ))
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirmStop}
        title="Stop this automation?"
        description="Nothing more is generated, and posts that haven’t started publishing are cancelled and go back to your drafts."
        confirmLabel="Stop"
        cancelLabel="Keep running"
        tone="danger"
        onCancel={() => setConfirmStop(false)}
        onConfirm={() => {
          setConfirmStop(false)
          if (run) void act(() => relay.runs.stop(run.id))
        }}
      />
    </section>
  )
}
