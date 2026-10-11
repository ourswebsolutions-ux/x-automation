import { CircleX, Play, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AutomationConfig, AutomationRun, RunPlan } from '@shared/types/automation'
import { Button, Modal, Spinner, useToast } from '@/components/ui'
import { errorMessage, relay } from '@/lib/bridge'
import { formatDateTime, pluralize } from '@/lib/format'

interface Props {
  config: AutomationConfig
  presetId: string | null
  activeRun: AutomationRun | null
  onStarted: (run: AutomationRun) => void
  startLabel?: string
}

/** The pre-run summary, kept up to date as the form changes, with the single confirmation before Start. */
export function PlanPanel({ config, presetId, activeRun, onStarted, startLabel = 'Start automation' }: Props) {
  const toast = useToast()
  const [plan, setPlan] = useState<RunPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [starting, setStarting] = useState(false)
  const key = JSON.stringify(config)

  useEffect(() => {
    let live = true
    setChecking(true)
    const timer = setTimeout(() => {
      relay.runs
        .plan(config)
        .then((p) => live && (setPlan(p), setError(null)))
        .catch((e: unknown) => live && (setPlan(null), setError(errorMessage(e))))
        .finally(() => live && setChecking(false))
    }, 350)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [key])

  const blocking = plan?.problems.filter((p) => p.blocking) ?? []
  const warnings = plan?.problems.filter((p) => !p.blocking) ?? []
  const busy = activeRun && ['generating', 'awaiting-approval', 'paused'].includes(activeRun.status)
  const canStart = Boolean(plan?.ok) && !checking && !busy

  const start = async () => {
    setStarting(true)
    try {
      const run = await relay.runs.start(config, presetId)
      setConfirming(false)
      onStarted(run)
    } catch (e) {
      toast({ tone: 'danger', title: 'Automation didn’t start', description: errorMessage(e), duration: 9000 })
    } finally {
      setStarting(false)
    }
  }

  return (
    <aside aria-label="Summary" className="flex flex-col gap-4 rounded-lg border border-line bg-surface-2 px-5 py-4 @5xl:sticky @5xl:top-0">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-fg">Before you start</h2>
        {checking && <Spinner size={12} />}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      {plan && (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <Stat label="Profiles" value={`${plan.profiles.eligible} of ${plan.profiles.selected}`} detail={`${plan.profiles.available} available · ${plan.profiles.unavailable} unavailable`} />
            <Stat label="Posts" value={String(plan.posts)} detail={plan.fromDrafts ? `${plan.fromDrafts} from your drafts${plan.generations ? ` · ${plan.generations} generated` : ''}` : plan.generations !== plan.posts ? `${plan.generations} unique texts` : 'all different'} />
            <Stat label="Images" value={String(plan.images)} detail={config.content.generateImages ? (plan.fromDrafts ? 'for posts without one' : 'one per post') : config.content.source === 'drafts' ? (plan.images ? 'already on your posts' : 'text only') : config.content.existingAssetId ? 'library image' : 'text only'} />
            <Stat label="When" value={plan.firstRunAt ? formatDateTime(plan.firstRunAt) : '—'} detail={plan.lastRunAt && plan.lastRunAt !== plan.firstRunAt ? `last ${formatDateTime(plan.lastRunAt)}` : config.mode === 'manual-approval' ? 'after your approval' : ''} />
          </dl>
          <ul className="flex flex-col gap-1 text-xs text-fg-muted" aria-label="Enabled actions">
            {plan.actions.map((a) => (
              <li key={a}>· {a}</li>
            ))}
            {plan.engagementTasks > 0 && <li>· {pluralize(plan.engagementTasks, 'engagement task')} for you</li>}
          </ul>
          {(blocking.length > 0 || warnings.length > 0) && (
            <div className="flex flex-col gap-1.5 border-t border-line pt-3">
              {blocking.map((p) => (
                <p key={p.message} role="alert" className="flex gap-2 text-xs text-danger">
                  <CircleX size={13} className="mt-0.5 shrink-0" />
                  {p.message}
                </p>
              ))}
              {warnings.map((p) => (
                <p key={p.message} className="flex gap-2 text-xs text-warning">
                  <TriangleAlert size={13} className="mt-0.5 shrink-0" />
                  {p.message}
                </p>
              ))}
            </div>
          )}
        </>
      )}
      <Button variant="primary" icon={Play} className="h-10" disabled={!canStart} onClick={() => setConfirming(true)}>
        {startLabel}
      </Button>
      {busy && <p className="text-xs text-fg-subtle">A run is active. Finish, stop or approve it first.</p>}

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        dismissible={!starting}
        title={`Start “${config.name}”?`}
        description={config.mode === 'full-auto' ? 'Each post is published at its time, without asking again for each one.' : 'Each post waits for your approval before it is published.'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={starting}>
              Cancel
            </Button>
            <Button variant="primary" icon={Play} loading={starting} onClick={start}>
              Start
            </Button>
          </>
        }
      >
        {plan && (
          <ul className="flex flex-col gap-1.5 text-sm text-fg-muted">
            <li>
              {pluralize(plan.posts, 'post')} on {pluralize(plan.profiles.eligible, 'profile')}
              {plan.images ? (plan.images >= plan.posts ? ', each with a generated image' : ', with generated images') : ''}
              {plan.fromDrafts ? ` (${plan.fromDrafts} from your drafts)` : ''}
            </li>
            {plan.firstRunAt && <li>From {formatDateTime(plan.firstRunAt)}{plan.lastRunAt && plan.lastRunAt !== plan.firstRunAt ? ` to ${formatDateTime(plan.lastRunAt)}` : ''}</li>}
            {plan.actions.map((a) => (
              <li key={a}>{a}</li>
            ))}
            {warnings.map((p) => (
              <li key={p.message} className="text-warning">
                {p.message}
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </aside>
  )
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-2xs font-medium uppercase tracking-[0.06em] text-fg-faint">{label}</dt>
      <dd className="tabular truncate text-base text-fg">{value}</dd>
      {detail && <dd className="truncate text-2xs text-fg-subtle">{detail}</dd>}
    </div>
  )
}
