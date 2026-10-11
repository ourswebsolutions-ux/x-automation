import { CircleX, History, Play, SearchCheck, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import type { RunPlan } from '@shared/types/automation'
import type { TaskView } from '@shared/types/publishing'
import { Button, Notice, PageHeader, Spinner, StatusBadge, useToast } from '@/components/ui'
import { ReviewDialog } from '@/components/feature/ReviewDialog'
import { useActiveRun, usePresets, useRuns } from '@/data/automation'
import { useAutomation, useQueue } from '@/data/publishing'
import { errorMessage, relay } from '@/lib/bridge'
import { formatDateTime, pluralize } from '@/lib/format'
import { NAV_ITEMS } from '@/app/navigation'
import { CampaignForm, choicesFrom, defaultChoices, toConfig, type CampaignChoices } from './CampaignForm'
import { RunPanel, RUN_LABEL } from './RunPanel'

const STORAGE_KEY = 'axora.campaign.choices'
const load = (): CampaignChoices => {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<CampaignChoices> | null
    return stored ? { ...defaultChoices(), ...stored } : defaultChoices()
  } catch {
    return defaultChoices()
  }
}

/**
 * Campaign Automation: Post or Repost, profiles, posts, run time — then Start. Runs on the
 * existing automation engine and publishing queue (account check, one post at a time per profile,
 * posts with an unconfirmed outcome wait for your review).
 */
export function CampaignsPage() {
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const [choices, setChoices] = useState<CampaignChoices>(load)
  const [plan, setPlan] = useState<RunPlan | null>(null)
  const [checking, setChecking] = useState(false)
  const [starting, setStarting] = useState(false)
  const presets = usePresets()
  const active = useActiveRun()
  const runs = useRuns()
  const viewRun = params.get('run') ?? active.data?.id ?? null
  const config = toConfig(choices)
  const key = JSON.stringify(config)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(choices))
    } catch {
      // not critical
    }
  }, [choices])

  // ?draft=<id> (Create Post → "Use in a campaign") preselects a post; ?preset=<id> (dashboard) loads a saved setup.
  useEffect(() => {
    const draft = params.get('draft')
    const preset = params.get('preset') ? presets.data?.find((p) => p.id === params.get('preset')) : null
    if (!draft && !preset) return
    if (preset) setChoices(choicesFrom(preset.config))
    if (draft) setChoices((c) => ({ ...c, action: 'post', draftIds: [...new Set([...c.draftIds, draft])] }))
    setParams(
      (p) => {
        p.delete('draft')
        if (preset) p.delete('preset')
        return p
      },
      { replace: true }
    )
  }, [params, presets.data, setParams])

  // Links to items that need a review (notifications, Create Post) scroll to that list.
  useEffect(() => {
    if (params.get('queue') || params.get('view') === 'queue') setTimeout(() => document.getElementById('posting-queue')?.scrollIntoView({ behavior: 'smooth' }), 300)
  }, [params])

  // Live check of what Start would do.
  useEffect(() => {
    let live = true
    setChecking(true)
    const timer = setTimeout(() => {
      relay.runs
        .plan(config)
        .then((p) => live && setPlan(p))
        .catch(() => live && setPlan(null))
        .finally(() => live && setChecking(false))
    }, 300)
    return () => {
      live = false
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const blocking = plan?.problems.filter((p) => p.blocking) ?? []
  const warnings = plan?.problems.filter((p) => !p.blocking && !/planned as tasks|left out|Only \d+ draft|don’t fit/.test(p.message)) ?? []
  const busy = active.data && ['generating', 'awaiting-approval', 'paused'].includes(active.data.status)
  const canStart = Boolean(plan?.ok) && !checking && !busy && !starting
  const summary = !plan
    ? ''
    : choices.action === 'post'
      ? `${pluralize(plan.posts, 'post')} on ${pluralize(plan.profiles.eligible, 'profile')}`
      : `${pluralize(plan.engagementTasks, choices.action === 'repost' ? 'repost task' : 'comment task')} for your profiles`

  const start = async () => {
    setStarting(true)
    try {
      const run = await relay.runs.start(config)
      setParams({ run: run.id }, { replace: true })
      // These posts and links now belong to this campaign; the form is ready for the next one.
      setChoices((c) => ({ ...c, draftIds: [], repostLinks: [] }))
      toast({ tone: 'success', title: 'Campaign started' })
    } catch (error) {
      toast({ tone: 'danger', title: 'Campaign didn’t start', description: errorMessage(error), duration: 9000 })
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={NAV_ITEMS.campaigns.label} description="Post, repost or comment from your profiles — choose the profiles, the content and when to run." />

      {viewRun && <RunPanel runId={viewRun} />}

      <div className="grid grid-cols-1 gap-4 @5xl:grid-cols-[minmax(0,1fr)_320px]">
        <CampaignForm value={choices} onChange={setChoices} />
        <aside aria-label="Start" className="flex flex-col gap-3 self-start rounded-lg border border-line bg-surface-2 px-5 py-4 @5xl:sticky @5xl:top-0">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-fg">Start</h2>
            {checking && <Spinner size={12} />}
          </div>
          {plan && (
            <p className="text-sm text-fg-muted">
              {summary}
              {plan.profiles.selected > plan.profiles.eligible ? ` · ${plan.profiles.selected - plan.profiles.eligible} of the selected profiles can’t be used (not available or no confirmed account)` : ''}
              {plan.firstRunAt ? ` · from ${formatDateTime(plan.firstRunAt)}` : ''}
            </p>
          )}
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
          <Button variant="primary" icon={Play} className="h-10" disabled={!canStart} loading={starting} onClick={start}>
            Start campaign
          </Button>
          {busy && <p className="text-xs text-fg-subtle">A campaign is already running. Wait for it to finish or stop it first.</p>}
        </aside>
      </div>

      <NeedsAttention />

      {(runs.data?.length ?? 0) > 0 && (
        <section aria-label="Campaigns" className="flex flex-col gap-2">
          <h2 className="flex items-center gap-2 text-sm font-medium text-fg">
            <History size={14} className="text-fg-subtle" /> Recent campaigns
          </h2>
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface-2">
            {runs.data!.slice(0, 8).map((r) => (
              <li key={r.id}>
                <button type="button" className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-3" onClick={() => setParams({ run: r.id }, { replace: true })}>
                  <span className="min-w-0 flex-1 truncate text-sm text-fg">{r.name}</span>
                  <span className="text-xs text-fg-subtle">
                    {r.counts.published} of {r.counts.total} done{r.counts.failed ? ` · ${r.counts.failed} failed` : ''}
                  </span>
                  <StatusBadge tone={RUN_LABEL[r.status].tone}>{RUN_LABEL[r.status].label}</StatusBadge>
                  <span className="tabular w-32 text-right text-xs text-fg-subtle">{formatDateTime(r.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/**
 * Publishing safety, kept: posts X didn't confirm wait for your review (never retried blindly),
 * failures can be retried, and a paused publishing queue can be resumed.
 */
function NeedsAttention() {
  const toast = useToast()
  const attention = useQueue({ view: 'attention' })
  const automation = useAutomation()
  const [reviewing, setReviewing] = useState<TaskView | null>(null)
  const list = (attention.data ?? []).filter((t) => t.status === 'needs-review' || t.status === 'failed')
  const paused = automation.data?.state === 'paused'
  if (!list.length && !paused) return null
  return (
    <section id="posting-queue" aria-label="Needs your attention" className="flex scroll-mt-4 flex-col gap-2">
      {paused && (
        <Notice tone="warning" title="Publishing is paused">
          Posts wait until you resume.{' '}
          <Button size="sm" variant="primary" onClick={() => void relay.control.resume().then(automation.reload)}>
            Resume publishing
          </Button>
        </Notice>
      )}
      {list.length > 0 && (
        <>
          <h2 className="flex items-center gap-2 text-sm font-medium text-fg">
            <SearchCheck size={14} className="text-fg-subtle" /> Needs your attention
          </h2>
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface-2">
            {list.slice(0, 20).map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1 truncate text-sm text-fg">{t.draftPreview || t.label}</span>
                <span className="text-xs text-fg-subtle">{t.accountHandle ? `@${t.accountHandle}` : (t.accountLabel ?? '')}</span>
                <StatusBadge tone={t.status === 'failed' ? 'danger' : 'warning'}>{t.status === 'failed' ? 'Failed' : 'Check whether it was posted'}</StatusBadge>
                {t.status === 'needs-review' ? (
                  <Button size="sm" onClick={() => setReviewing(t)}>
                    Review
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() =>
                      void relay.queue
                        .retry(t.id)
                        .then(() => toast({ tone: 'success', title: 'Retrying' }))
                        .catch((e: unknown) => toast({ tone: 'danger', title: 'Not retried', description: errorMessage(e) }))
                    }
                  >
                    Retry
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <ReviewDialog task={reviewing} onClose={() => setReviewing(null)} />
    </section>
  )
}
