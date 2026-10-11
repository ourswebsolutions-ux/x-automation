import { ArrowRight, ListChecks } from 'lucide-react'
import { useNavigate } from 'react-router'
import type { Task } from '@shared/types/domain'
import type { TaskView } from '@shared/types/publishing'
import { Button, DataTable, DemoBadge, EmptyState, LiveBadge, Panel, StatusBadge, type Column } from '@/components/ui'
import { demoAccountHandle } from '@/data/demo'
import type { useWorkspaceSummary } from '@/data/workspace'
import { formatRelative } from '@/lib/format'
import { TASK_KIND, TASK_STATUS } from '@/lib/status'
import { NAV_ITEMS } from '@/app/navigation'

type Summary = ReturnType<typeof useWorkspaceSummary>

const columns: Column<Task>[] = [
  {
    id: 'task',
    header: 'Task',
    width: '42%',
    cell: (task) => (
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-fg">{(task as Partial<TaskView>).draftPreview || task.label}</span>
        <span className="truncate text-xs text-fg-subtle">{TASK_KIND[task.kind]}</span>
      </div>
    )
  },
  {
    id: 'account',
    header: 'Account',
    width: '22%',
    cell: (task) => {
      const live = task as Partial<TaskView>
      const handle = live.accountHandle ?? demoAccountHandle(task.accountId)
      return handle ? `@${handle}` : live.accountLabel ? live.accountLabel : <span className="text-fg-faint">—</span>
    }
  },
  {
    id: 'status',
    header: 'Status',
    width: '18%',
    cell: (task) => {
      const meta = TASK_STATUS[task.status]
      return (
        <StatusBadge tone={meta.tone} dot pulse={meta.pulse}>
          {meta.label}
        </StatusBadge>
      )
    }
  },
  {
    id: 'when',
    header: 'Updated',
    align: 'right',
    cell: (task) => <span className="tabular text-xs text-fg-subtle">{formatRelative(task.finishedAt ?? task.createdAt)}</span>
  }
]

export function RecentTasksPanel({ summary }: { summary: Summary }) {
  const navigate = useNavigate()
  return (
    <Panel
      title="Recent tasks"
      meta={summary.demo ? <DemoBadge /> : <LiveBadge />}
      actions={
        <Button size="sm" variant="ghost" trailingIcon={ArrowRight} onClick={() => navigate(NAV_ITEMS.queue.path)}>
          Task queue
        </Button>
      }
      padded={false}
    >
      <DataTable
        aria-label="Recent tasks"
        rows={summary.data?.recentTasks ?? []}
        columns={columns}
        rowKey={(task) => task.id}
        loading={!summary.data && summary.status === 'loading'}
        density="compact"
        empty={
          <EmptyState
            size="sm"
            icon={ListChecks}
            title="No tasks have run"
            description="Scheduled and published posts appear here as the task queue runs them."
          />
        }
      />
    </Panel>
  )
}
