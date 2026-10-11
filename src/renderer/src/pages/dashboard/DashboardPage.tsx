import { PHASE } from '@shared/config/roadmap'
import { CalendarClock, FileText, ListChecks, Settings, SquarePen, UsersRound } from 'lucide-react'
import { useNavigate } from 'react-router'
import { Button, MetricCard, Notice, PageHeader } from '@/components/ui'
import { DEMO_HINTS } from '@/data/demo'
import { useWorkspaceSummary } from '@/data/workspace'
import { MOD_LABEL } from '@/hooks/useHotkey'
import { formatLongDate } from '@/lib/format'
import { usePreferences } from '@/state/preferences'
import { NAV_ITEMS, settingsPath } from '@/app/navigation'
import { ActivityPanel } from './ActivityPanel'
import { AutomationPanel } from './AutomationPanel'
import { IntegrationsPanel } from './IntegrationsPanel'
import { QuickActionsPanel } from './QuickActionsPanel'
import { RecentTasksPanel } from './RecentTasksPanel'
import { SystemPanel } from './SystemPanel'

export function DashboardPage() {
  const navigate = useNavigate()
  const { update } = usePreferences()
  const summary = useWorkspaceSummary()
  const data = summary.data
  const loading = summary.status === 'loading' && !data

  const hints = summary.demo
    ? DEMO_HINTS
    : {
        profiles: data?.profiles ? 'Linked to IX Browser' : `Profile sync arrives in Phase ${PHASE.ixBrowser}`,
        drafts: data?.drafts ? 'Saved on this device' : 'No drafts yet',
        scheduled: data?.scheduled ? 'Waiting to go out' : 'Nothing scheduled',
        pendingTasks: data?.pendingTasks ? 'Waiting or running' : 'Queue is idle'
      }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Dashboard"
        description={formatLongDate()}
        actions={
          <>
            <Button icon={Settings} onClick={() => navigate(settingsPath('general'))}>
              Settings
            </Button>
            <Button variant="primary" icon={SquarePen} onClick={() => navigate('/posts?compose=1')} title={`New draft (${MOD_LABEL}+N)`}>
              New draft
            </Button>
          </>
        }
      />

      {summary.demo && (
        <Notice
          tone="warning"
          title="You're looking at demo data"
          actions={
            <Button size="sm" variant="secondary" onClick={() => update({ showDemoData: false })}>
              Show live workspace
            </Button>
          }
        >
          Accounts, tasks and activity below are samples for previewing the interface. System and integration panels always show the
          real state of this installation.
        </Notice>
      )}

      <div className="grid grid-cols-2 gap-3 @4xl:grid-cols-4">
        <MetricCard
          label="Connected profiles"
          icon={UsersRound}
          value={data?.profiles ?? null}
          loading={loading}
          hint={hints.profiles}
          onClick={() => navigate(NAV_ITEMS.accounts.path)}
        />
        <MetricCard
          label="Drafts"
          icon={FileText}
          value={data?.drafts ?? null}
          loading={loading}
          hint={hints.drafts}
          onClick={() => navigate(NAV_ITEMS.posts.path)}
        />
        <MetricCard
          label="Scheduled posts"
          icon={CalendarClock}
          value={data?.scheduled ?? null}
          loading={loading}
          hint={hints.scheduled}
          onClick={() => navigate(NAV_ITEMS.scheduler.path)}
        />
        <MetricCard
          label="Pending tasks"
          icon={ListChecks}
          value={data?.pendingTasks ?? null}
          loading={loading}
          hint={hints.pendingTasks}
          onClick={() => navigate(NAV_ITEMS.queue.path)}
        />
      </div>

      <AutomationPanel />

      <div className="grid grid-cols-1 gap-4 @5xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          <ActivityPanel summary={summary} />
          <RecentTasksPanel summary={summary} />
        </div>
        <div className="grid min-w-0 grid-cols-1 content-start gap-4 @3xl:grid-cols-2 @5xl:grid-cols-1">
          <QuickActionsPanel />
          <SystemPanel />
          <IntegrationsPanel />
        </div>
      </div>
    </div>
  )
}
