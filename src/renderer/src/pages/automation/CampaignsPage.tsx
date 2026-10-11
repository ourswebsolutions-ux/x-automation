import { BookmarkPlus, CalendarClock, History, Pause, Play, Repeat, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import type { AutomationConfig, AutomationSchedule } from '@shared/types/automation'
import { Button, ConfirmDialog, Field, IconButton, Input, Modal, Notice, PageHeader, Select, StatusBadge, useToast } from '@/components/ui'
import { useActiveRun, useAutomationSchedules, usePresets, useRuns } from '@/data/automation'
import { useSchedules } from '@/data/publishing'
import { SCHEDULE_STATUS } from '@/lib/status'
import { errorMessage, relay } from '@/lib/bridge'
import { formatDateTime } from '@/lib/format'
import { NAV_ITEMS } from '@/app/navigation'
import { PostingQueue } from '../queue/PostingQueue'
import { asCampaign, CampaignForm } from './CampaignForm'
import { defaultConfig, loadDraftConfig, saveDraftConfig } from './defaults'
import { PlanPanel } from './PlanPanel'
import { RunPanel } from './RunPanel'

const RUN_LABEL: Record<string, string> = {
  generating: 'Preparing',
  'awaiting-approval': 'Waiting for approval',
  publishing: 'Running',
  paused: 'Paused',
  completed: 'Finished',
  stopped: 'Stopped',
  failed: 'Failed'
}

/**
 * Campaign Automation: choose saved posts and accounts, set the schedule, start — then pause,
 * resume or stop, follow progress and next posting times, and handle anything that needs you
 * (posting queue). Runs on the existing automation engine and publishing queue.
 */
export function CampaignsPage() {
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const [config, setConfig] = useState<AutomationConfig>(() => asCampaign(loadDraftConfig()).config)
  const [converted, setConverted] = useState(false)
  const [presetId, setPresetId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [deleting, setDeleting] = useState(false)
  const presets = usePresets()
  const active = useActiveRun()
  const runs = useRuns()
  const viewRun = params.get('run') ?? active.data?.id ?? null

  useEffect(() => saveDraftConfig(config), [config])

  // ?draft=<id> (from Create Post → "Use in a campaign") preselects that post; ?preset=<id> loads a saved setup.
  useEffect(() => {
    const draft = params.get('draft')
    const wanted = params.get('preset')
    const preset = wanted ? presets.data?.find((p) => p.id === wanted) : null
    if (!draft && !preset) return
    if (draft) setConfig((c) => ({ ...c, content: { ...c.content, source: 'drafts', draftIds: [...new Set([...c.content.draftIds, draft])] } }))
    if (preset) loadPreset(preset.id)
    setParams(
      (p) => {
        p.delete('draft')
        if (preset) p.delete('preset')
        return p
      },
      { replace: true }
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, presets.data])

  // Links to the queue (…?view=queue / ?queue=…) or scheduled posts (…?view=scheduled) scroll there.
  useEffect(() => {
    const target = params.get('view') === 'scheduled' ? 'scheduled-posts' : params.get('view') === 'queue' || params.get('queue') ? 'posting-queue' : null
    if (target) setTimeout(() => document.getElementById(target)?.scrollIntoView({ behavior: 'smooth' }), 300)
  }, [params])

  function loadPreset(id: string) {
    const preset = presets.data?.find((p) => p.id === id)
    if (!preset) return
    const result = asCampaign(preset.config)
    setConfig(result.config)
    setConverted(result.converted)
    setPresetId(preset.id)
    toast({ tone: 'info', title: `Loaded “${preset.name}”` })
  }

  const savePreset = async () => {
    try {
      const preset = await relay.presets.save({ ...(presetId && presets.data?.find((p) => p.id === presetId)?.name === presetName.trim() ? { id: presetId } : {}), name: presetName.trim(), config: { ...config, name: presetName.trim() } })
      setPresetId(preset.id)
      setConfig(asCampaign(preset.config).config)
      setSaving(false)
      presets.reload()
      toast({ tone: 'success', title: 'Campaign setup saved' })
    } catch (e) {
      toast({ tone: 'danger', title: 'Not saved', description: errorMessage(e) })
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={NAV_ITEMS.campaigns.label}
        description={NAV_ITEMS.campaigns.description}
        actions={
          <>
            {(presets.data?.length ?? 0) > 0 && (
              <Select<string> className="w-52" aria-label="Saved campaign setups" value={presetId} placeholder="Load a saved setup…" onChange={loadPreset} options={presets.data!.map((p) => ({ value: p.id, label: p.name }))} />
            )}
            {presetId && <IconButton icon={Trash2} label="Delete saved setup" onClick={() => setDeleting(true)} />}
            <Button
              icon={BookmarkPlus}
              onClick={() => {
                setPresetName(presets.data?.find((p) => p.id === presetId)?.name ?? config.name)
                setSaving(true)
              }}
            >
              Save setup
            </Button>
            <IconButton
              icon={RotateCcw}
              label="Start over"
              onClick={() => {
                setConfig(asCampaign(defaultConfig()).config)
                setPresetId(null)
                setConverted(false)
              }}
            />
          </>
        }
      />

      {converted && (
        <Notice tone="accent" title="This saved setup wrote posts with AI">
          Campaigns now post saved posts. Create the posts in Create Post (AI or manual), then choose them below — the accounts and schedule were kept.
        </Notice>
      )}

      {viewRun && <RunPanel runId={viewRun} />}

      <div className="grid grid-cols-1 gap-4 @5xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex flex-col gap-4">
          <Field label="Campaign name" htmlFor="camp-name">
            <Input id="camp-name" value={config.name} maxLength={80} onChange={(e) => setConfig({ ...config, name: e.target.value })} />
          </Field>
          <CampaignForm config={config} onChange={setConfig} />
        </div>
        <PlanPanel config={{ ...config, name: config.name.trim() || 'Campaign' }} presetId={presetId} activeRun={active.data ?? null} startLabel="Start campaign" onStarted={(run) => setParams({ run: run.id }, { replace: true })} />
      </div>

      <CampaignHistory onOpen={(id) => setParams({ run: id }, { replace: true })} runs={runs.data ?? []} />
      <RecurringCampaigns />
      <ScheduledPosts />
      <PostingQueue />

      <Modal
        open={saving}
        onClose={() => setSaving(false)}
        size="sm"
        title="Save campaign setup"
        description="Saves the chosen posts, accounts and schedule to reuse later."
        footer={
          <>
            <Button variant="ghost" onClick={() => setSaving(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!presetName.trim()} onClick={savePreset}>
              Save
            </Button>
          </>
        }
      >
        <Field label="Name" htmlFor="preset-name">
          <Input id="preset-name" value={presetName} maxLength={80} onChange={(e) => setPresetName(e.target.value)} />
        </Field>
      </Modal>
      <ConfirmDialog
        open={deleting}
        title="Delete this saved setup?"
        description="Campaigns started from it are kept."
        confirmLabel="Delete"
        tone="danger"
        onCancel={() => setDeleting(false)}
        onConfirm={async () => {
          setDeleting(false)
          if (!presetId) return
          try {
            await relay.presets.remove(presetId)
            setPresetId(null)
            presets.reload()
          } catch (e) {
            toast({ tone: 'danger', title: 'Not deleted', description: errorMessage(e) })
          }
        }}
      />
    </div>
  )
}

function CampaignHistory({ runs, onOpen }: { runs: { id: string; name: string; mode: string; status: string; createdAt: string; counts: { published: number; failed: number; total: number } }[]; onOpen: (id: string) => void }) {
  if (!runs.length) return null
  return (
    <section aria-label="Campaigns" className="flex flex-col gap-2">
      <h2 className="flex items-center gap-2 text-sm font-medium text-fg">
        <History size={14} className="text-fg-subtle" /> Campaigns
      </h2>
      <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface-2">
        {runs.slice(0, 10).map((r) => (
          <li key={r.id}>
            <button type="button" className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-3" onClick={() => onOpen(r.id)}>
              <span className="min-w-0 flex-1 truncate text-sm text-fg">{r.name}</span>
              <span className="text-xs text-fg-subtle">
                {r.counts.published} of {r.counts.total} published{r.counts.failed ? ` · ${r.counts.failed} failed` : ''}
              </span>
              <StatusBadge tone={r.status === 'completed' ? 'success' : r.status === 'paused' || r.status === 'awaiting-approval' ? 'warning' : r.status === 'failed' ? 'danger' : 'neutral'}>{RUN_LABEL[r.status] ?? r.status}</StatusBadge>
              <span className="tabular w-32 text-right text-xs text-fg-subtle">{formatDateTime(r.createdAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Recurring campaigns created earlier (one AI run per chosen day) keep running and stay manageable here. */
function RecurringCampaigns() {
  const toast = useToast()
  const navigate = useNavigate()
  const schedules = useAutomationSchedules()
  const [removing, setRemoving] = useState<AutomationSchedule | null>(null)
  const list = schedules.data ?? []
  if (!list.length) return null
  const act = async (action: () => Promise<unknown>, title: string) => {
    try {
      await action()
      toast({ tone: 'success', title })
    } catch (e) {
      toast({ tone: 'danger', title: 'That didn’t work', description: errorMessage(e) })
    } finally {
      schedules.reload()
    }
  }
  return (
    <section aria-label="Recurring campaigns" className="flex flex-col gap-2">
      <h2 className="flex items-center gap-2 text-sm font-medium text-fg">
        <Repeat size={14} className="text-fg-subtle" /> Recurring campaigns
      </h2>
      <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface-2">
        {list.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-center gap-2 text-sm text-fg">
                {s.name}
                <StatusBadge tone={s.status === 'active' ? 'success' : s.status === 'paused' ? 'warning' : 'neutral'} dot>
                  {s.status === 'active' ? 'Active' : s.status === 'paused' ? 'Paused' : 'Ended'}
                </StatusBadge>
              </span>
              <span className="text-xs text-fg-subtle">
                {s.windowStart}–{s.windowEnd} · {s.startDate}
                {s.endDate ? ` to ${s.endDate}` : ''} · {s.nextRunAt ? `next ${formatDateTime(s.nextRunAt)}` : 'no upcoming day'}
                {s.lastMessage ? ` · ${s.lastMessage}` : ''}
              </span>
            </span>
            {s.lastRunId && (
              <Button size="sm" variant="ghost" onClick={() => navigate(`${NAV_ITEMS.campaigns.path}?run=${s.lastRunId}`)}>
                Last run
              </Button>
            )}
            {s.status === 'active' && (
              <Button size="sm" icon={Pause} onClick={() => act(() => relay.automationSchedules.pause(s.id), 'Recurring campaign paused')}>
                Pause
              </Button>
            )}
            {s.status === 'paused' && (
              <Button size="sm" variant="primary" icon={Play} onClick={() => act(() => relay.automationSchedules.resume(s.id), 'Recurring campaign resumed')}>
                Resume
              </Button>
            )}
            <IconButton icon={Trash2} label="Delete recurring campaign" size="sm" onClick={() => setRemoving(s)} />
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={removing !== null}
        title="Delete this recurring campaign?"
        description="Runs it already started are kept."
        confirmLabel="Delete"
        tone="danger"
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const target = removing
          setRemoving(null)
          if (target) void act(() => relay.automationSchedules.remove(target.id), 'Recurring campaign deleted')
        }}
      />
    </section>
  )
}

/** Single scheduled posts (and missed ones) at a glance; each opens in Create Post to change or cancel. */
function ScheduledPosts() {
  const navigate = useNavigate()
  const upcoming = useSchedules({ view: 'upcoming' })
  const attention = useSchedules({ view: 'attention' })
  const list = [...(attention.data ?? []), ...(upcoming.data ?? [])].filter((e, i, all) => all.findIndex((x) => x.schedule.id === e.schedule.id) === i)
  if (!list.length) return null
  return (
    <section id="scheduled-posts" aria-label="Scheduled posts" className="flex scroll-mt-4 flex-col gap-2">
      <h2 className="flex items-center gap-2 text-sm font-medium text-fg">
        <CalendarClock size={14} className="text-fg-subtle" /> Scheduled posts
      </h2>
      <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface-2">
        {list.slice(0, 20).map(({ schedule, draft, account }) => {
          const meta = SCHEDULE_STATUS[schedule.status]
          return (
            <li key={schedule.id}>
              <button type="button" className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-3" onClick={() => draft && navigate(`${NAV_ITEMS.create.path}?draft=${draft.id}`)}>
                <span className="min-w-0 flex-1 truncate text-sm text-fg">{draft?.preview || 'Post'}</span>
                <span className="text-xs text-fg-subtle">{account ? (account.handle ? `@${account.handle}` : account.label) : 'Removed account'}</span>
                <StatusBadge tone={meta.tone} dot>
                  {meta.label}
                </StatusBadge>
                <span className="tabular w-32 text-right text-xs text-fg-subtle">{formatDateTime(schedule.runAt)}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
