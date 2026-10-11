import { CircleCheck, CircleDashed, CircleX, ExternalLink, FileText, ListChecks, Pause, Play, RotateCw, SearchCheck, TriangleAlert, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import type { QueueQuery, TaskRunView, TaskView } from '@shared/types/publishing'
import { Button, ConfirmDialog, DataTable, EmptyState, IconButton, PageHeader, Panel, SearchField, Skeleton, StatusBadge, Tabs, useToast, type Column } from '@/components/ui'
import { ReviewDialog } from '@/components/feature/ReviewDialog'
import { useAutomation, useQueue, useQueueCounts, useTaskDetails } from '@/data/publishing'
import { ControlCenter } from './ControlCenter'
import { useQueryParam } from '@/hooks/useQueryParam'
import { errorMessage, relay } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { formatDateTime, formatRelative } from '@/lib/format'
import { TASK_KIND, TASK_STATUS } from '@/lib/status'
import { NAV_ITEMS } from '@/app/navigation'

type View = QueueQuery['view']
const VIEWS: View[] = ['active', 'attention', 'done', 'all']

const RUN_OUTCOME: Record<TaskRunView['status'], { label: string; icon: typeof CircleCheck; className: string }> = {
  running: { label: 'Running', icon: CircleDashed, className: 'text-info' },
  succeeded: { label: 'Succeeded', icon: CircleCheck, className: 'text-success' },
  failed: { label: 'Failed', icon: CircleX, className: 'text-danger' },
  cancelled: { label: 'Stopped', icon: CircleDashed, className: 'text-fg-subtle' },
  uncertain: { label: 'Outcome unknown', icon: TriangleAlert, className: 'text-warning' }
}

/** When it ran or will run, in words. */
function when(t: TaskView): string {
  if (t.status === 'queued') return new Date(t.runAfter).getTime() > Date.now() + 30_000 ? `Starts ${formatRelative(t.runAfter)}` : 'Next up'
  if (t.status === 'running') return t.startedAt ? `Started ${formatRelative(t.startedAt)}` : 'Running'
  return t.finishedAt ? formatRelative(t.finishedAt) : formatRelative(t.createdAt)
}

export function QueuePage() {
  const navigate = useNavigate()
  const toast = useToast()
  const [viewParam, setViewParam] = useQueryParam('view')
  const view: View = VIEWS.includes(viewParam as View) ? (viewParam as View) : 'active'
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [reviewing, setReviewing] = useState<TaskView | null>(null)
  const [cancelling, setCancelling] = useState<TaskView | null>(null)
  const tasks = useQueue({ view })
  const counts = useQueueCounts()
  const automation = useAutomation()

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (tasks.data ?? []).filter((t) => !q || `${t.label} ${t.draftPreview ?? ''} ${t.accountLabel ?? ''} ${t.accountHandle ?? ''}`.toLowerCase().includes(q))
  }, [tasks.data, query])
  const active = rows.find((t) => t.id === activeId) ?? (tasks.data ?? []).find((t) => t.id === activeId) ?? null

  const act = async (action: () => Promise<unknown>, title: string, description?: string) => {
    try {
      await action()
      toast({ tone: 'success', title, description })
    } catch (error) {
      toast({ tone: 'danger', title: 'That didn’t work', description: errorMessage(error) })
    }
  }

  const c = counts.data
  const columns: Column<TaskView>[] = [
    {
      id: 'task',
      header: 'Task',
      width: '40%',
      sortValue: (t) => t.draftPreview ?? t.label,
      cell: (t) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-fg">{t.draftPreview || t.label}</span>
          <span className="truncate text-xs text-fg-subtle">{TASK_KIND[t.kind]}</span>
        </span>
      )
    },
    {
      id: 'account',
      header: 'Account',
      width: '18%',
      sortValue: (t) => t.accountLabel ?? '',
      cell: (t) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm text-fg-muted">{t.accountLabel ?? '—'}</span>
          {t.accountHandle && <span className="truncate text-xs text-fg-subtle">@{t.accountHandle}</span>}
        </span>
      )
    },
    {
      id: 'status',
      header: 'Status',
      width: '22%',
      sortValue: (t) => t.status,
      cell: (t) => (
        <span className="flex min-w-0 flex-col items-start gap-0.5">
          <StatusBadge tone={TASK_STATUS[t.status].tone} dot pulse={TASK_STATUS[t.status].pulse}>
            {TASK_STATUS[t.status].label}
          </StatusBadge>
          {t.status === 'running' && t.stage && <span className="truncate text-2xs text-fg-subtle">{t.stage}…</span>}
          {t.status === 'queued' && t.held && <span className="truncate text-2xs text-warning">On hold</span>}
          {t.status === 'queued' && !t.held && t.attempts > 0 && <span className="truncate text-2xs text-fg-subtle">Retry {t.attempts + 1} of {t.maxAttempts}</span>}
        </span>
      )
    },
    {
      id: 'when',
      header: 'When',
      align: 'right',
      sortValue: (t) => t.finishedAt ?? t.runAfter,
      cell: (t) => <span className="tabular text-xs text-fg-subtle">{when(t)}</span>
    }
  ]

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={NAV_ITEMS.queue.label}
        description="Every post X Auto publishes runs here, one account at a time."
        meta={
          c && (
            <span className="flex items-center gap-2 text-xs text-fg-subtle">
              {c.running > 0 && <StatusBadge tone="info" dot pulse>{`${c.running} running`}</StatusBadge>}
              {c.queued > 0 && <span>{c.queued} waiting</span>}
            </span>
          )
        }
      />

      <ControlCenter snapshot={automation.data} onChange={automation.reload} />

      <div className="grid grid-cols-1 gap-4 @5xl:grid-cols-[minmax(0,1fr)_360px]">
        <Panel padded={false}>
          <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 px-4 pt-1">
            <Tabs<View>
              aria-label="Filter tasks"
              value={view}
              onChange={(next) => {
                setViewParam(next === 'active' ? '' : next)
                setActiveId(null)
              }}
              className="border-b-0"
              items={[
                { value: 'active', label: 'Active', count: c ? c.queued + c.running : undefined },
                { value: 'attention', label: 'Needs attention', count: c ? c.needsReview + c.failed : undefined },
                { value: 'done', label: 'Done' },
                { value: 'all', label: 'All' }
              ]}
            />
            <SearchField value={query} onChange={setQuery} placeholder="Search tasks" size="sm" className="mb-2 w-56" />
          </div>
          <div className="border-t border-line">
            <DataTable
              aria-label="Tasks"
              rows={rows}
              columns={columns}
              rowKey={(t) => t.id}
              loading={tasks.status === 'loading' && !tasks.data}
              activeKey={activeId}
              onRowClick={(t) => setActiveId((current) => (current === t.id ? null : t.id))}
              empty={
                <EmptyState
                  size="sm"
                  icon={view === 'attention' ? SearchCheck : ListChecks}
                  title={query ? 'No tasks match' : view === 'attention' ? 'Nothing needs your attention' : view === 'active' ? 'Nothing is waiting' : 'No tasks yet'}
                  description={query ? 'Try a different search.' : view === 'active' ? 'Schedule a post or choose Publish now on a draft.' : undefined}
                  actions={
                    view === 'active' && !query ? (
                      <Button size="sm" icon={FileText} onClick={() => navigate('/posts')}>
                        Go to drafts
                      </Button>
                    ) : undefined
                  }
                />
              }
            />
          </div>
        </Panel>

        <TaskPanel
          task={active}
          onClose={() => setActiveId(null)}
          onReview={setReviewing}
          onCancel={setCancelling}
          onRetry={(t) => act(() => relay.queue.retry(t.id), 'Retrying', 'It will run again shortly.')}
          onHold={(t, held) => act(() => (held ? relay.control.hold(t.id) : relay.control.release(t.id)), held ? 'Put on hold' : 'Released', held ? 'It stays in the queue until you release it.' : undefined)}
          onOpenDraft={(t) => t.draftId && navigate(`/posts?draft=${t.draftId}`)}
        />
      </div>

      <ReviewDialog task={reviewing} onClose={() => setReviewing(null)} />
      <ConfirmDialog
        open={Boolean(cancelling)}
        title={cancelling?.status === 'running' ? 'Stop this task?' : 'Cancel this task?'}
        description={
          cancelling?.status === 'running'
            ? 'It stops before posting if it hasn’t started posting yet. A post that is already being submitted can’t be called back.'
            : 'It won’t run. A scheduled post goes back to your drafts.'
        }
        confirmLabel={cancelling?.status === 'running' ? 'Stop' : 'Cancel task'}
        cancelLabel="Keep it"
        tone="danger"
        onCancel={() => setCancelling(null)}
        onConfirm={() => {
          const t = cancelling
          setCancelling(null)
          if (!t) return
          void (async () => {
            try {
              const outcome = await relay.queue.cancel(t.id)
              toast(outcome === 'cancelled' ? { tone: 'success', title: 'Task cancelled' } : { tone: 'info', title: 'Stopping…', description: 'It stops at the next safe point.' })
            } catch (error) {
              toast({ tone: 'danger', title: 'Not cancelled', description: errorMessage(error) })
            }
          })()
        }}
      />
    </div>
  )
}

interface TaskPanelProps {
  task: TaskView | null
  onClose: () => void
  onReview: (task: TaskView) => void
  onCancel: (task: TaskView) => void
  onRetry: (task: TaskView) => void
  onHold: (task: TaskView, held: boolean) => void
  onOpenDraft: (task: TaskView) => void
}

function TaskPanel({ task, onClose, onReview, onCancel, onRetry, onHold, onOpenDraft }: TaskPanelProps) {
  const details = useTaskDetails(task?.id ?? null)
  if (!task) {
    return (
      <Panel title="Details">
        <p className="text-sm text-fg-subtle">Select a task to see its attempts and what you can do next.</p>
      </Panel>
    )
  }
  const meta = TASK_STATUS[task.status]
  const runs = details.data?.runs ?? []
  const url = task.result?.url ?? null
  return (
    <Panel
      title={<span className="truncate">{TASK_KIND[task.kind]}</span>}
      meta={
        <StatusBadge tone={meta.tone} dot pulse={meta.pulse}>
          {meta.label}
        </StatusBadge>
      }
      actions={<IconButton icon={X} label="Close details" size="sm" onClick={onClose} />}
      padded={false}
    >
      <div className="flex flex-col gap-4 px-4 py-3">
        {task.draftPreview && <p className="text-sm text-fg">{task.draftPreview}</p>}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
          <dt className="text-fg-subtle">Account</dt>
          <dd className="truncate text-right text-fg-muted">{task.accountLabel ? `${task.accountLabel}${task.accountHandle ? ` · @${task.accountHandle}` : ''}` : '—'}</dd>
          <dt className="text-fg-subtle">Added</dt>
          <dd className="text-right text-fg-muted">{formatDateTime(task.createdAt)}</dd>
          {task.status === 'queued' && (
            <>
              <dt className="text-fg-subtle">Starts</dt>
              <dd className="text-right text-fg-muted">{formatDateTime(task.runAfter)}</dd>
            </>
          )}
          {task.finishedAt && (
            <>
              <dt className="text-fg-subtle">Finished</dt>
              <dd className="text-right text-fg-muted">{formatDateTime(task.finishedAt)}</dd>
            </>
          )}
        </dl>

        {task.status === 'needs-review' && (
          <div role="alert" className="flex gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning">
            <TriangleAlert size={13} className="mt-0.5 shrink-0" />
            <span>{task.error ?? 'The outcome is unknown.'} Nothing is retried until you check.</span>
          </div>
        )}
        {task.status === 'failed' && task.error && (
          <div role="alert" className="flex gap-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">
            <CircleX size={13} className="mt-0.5 shrink-0" />
            <span>{task.error}</span>
          </div>
        )}
        {task.status === 'succeeded' && task.result?.verifiedBy === 'user' && <p className="text-xs text-fg-subtle">You confirmed this was posted.</p>}

        <div className="flex flex-wrap gap-1.5">
          {task.status === 'needs-review' && (
            <Button size="sm" variant="primary" icon={SearchCheck} onClick={() => onReview(task)}>
              Check and confirm
            </Button>
          )}
          {task.status === 'failed' && (
            <Button size="sm" variant="primary" icon={RotateCw} onClick={() => onRetry(task)}>
              Retry
            </Button>
          )}
          {task.status === 'queued' && (
            <Button size="sm" variant="secondary" icon={task.held ? Play : Pause} onClick={() => onHold(task, !task.held)}>
              {task.held ? 'Release' : 'Hold'}
            </Button>
          )}
          {(task.status === 'queued' || task.status === 'running') && (
            <Button size="sm" variant="secondary" icon={X} onClick={() => onCancel(task)}>
              {task.status === 'running' ? 'Stop' : 'Cancel'}
            </Button>
          )}
          {url && (
            <Button size="sm" variant="secondary" icon={ExternalLink} onClick={() => void relay.shell.openExternal(url)}>
              View on X
            </Button>
          )}
          {task.draftId && (
            <Button size="sm" variant="ghost" icon={FileText} onClick={() => onOpenDraft(task)}>
              Open draft
            </Button>
          )}
        </div>

        <section aria-label="Attempts" className="flex flex-col gap-2">
          <h3 className="text-2xs font-medium uppercase tracking-[0.07em] text-fg-faint">Attempts</h3>
          {details.status === 'loading' && !details.data ? (
            <Skeleton className="h-10" />
          ) : runs.length === 0 ? (
            <p className="text-xs text-fg-subtle">Not started yet.</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {runs.map((run) => {
                const outcome = RUN_OUTCOME[run.status]
                const Icon = outcome.icon
                return (
                  <li key={`${run.attempt}-${run.startedAt}`} className="flex gap-2 text-xs">
                    <Icon size={13} className={cn('mt-0.5 shrink-0', outcome.className)} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex items-baseline justify-between gap-2 text-fg">
                        Attempt {run.attempt} · {outcome.label}
                        <span className="tabular shrink-0 text-2xs text-fg-faint">{formatDateTime(run.startedAt)}</span>
                      </span>
                      {run.stage && <span className="text-fg-subtle">Reached: {run.stage}</span>}
                      {run.error && run.status !== 'succeeded' && <span className="text-fg-subtle">{run.error}</span>}
                    </span>
                  </li>
                )
              })}
            </ol>
          )}
        </section>
      </div>
    </Panel>
  )
}
