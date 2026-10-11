import { createHashRouter, Navigate, useRouteError } from 'react-router'
import { ErrorState } from '@/components/ui'
import { AppShell } from '@/layout/AppShell'
import { AccountsPage } from '@/pages/accounts/AccountsPage'
import { DashboardPage } from '@/pages/dashboard/DashboardPage'
import { GeneratorPage } from '@/pages/generator/GeneratorPage'
import { LinksPage } from '@/pages/links/LinksPage'
import { AutomationPage } from '@/pages/automation/AutomationPage'
import { SchedulesPage } from '@/pages/automation/SchedulesPage'
import { NotFoundPage } from '@/pages/NotFoundPage'
import { PostsPage } from '@/pages/posts/PostsPage'
import { QueuePage } from '@/pages/queue/QueuePage'
import { SchedulerPage } from '@/pages/scheduler/SchedulerPage'
import { SettingsPage } from '@/pages/settings/SettingsPage'
import { usePreferences } from '@/state/preferences'
import { NAV_ITEMS } from './navigation'

function StartPage() {
  const { preferences } = usePreferences()
  return <Navigate to={NAV_ITEMS[preferences.startPage].path} replace />
}

function RouteError() {
  const error = useRouteError()
  return (
    <div className="grid h-full place-items-center bg-canvas">
      <ErrorState title="This page could not be opened" error={error} onRetry={() => window.location.reload()} />
    </div>
  )
}

/** Hash routing works identically from the dev server and from file://. */
export const router = createHashRouter([
  {
    element: <AppShell />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <StartPage /> },
      { path: NAV_ITEMS.dashboard.path, element: <DashboardPage /> },
      { path: NAV_ITEMS.accounts.path, element: <AccountsPage /> },
      { path: NAV_ITEMS.generator.path, element: <GeneratorPage /> },
      { path: NAV_ITEMS.posts.path, element: <PostsPage /> },
      { path: NAV_ITEMS.scheduler.path, element: <SchedulerPage /> },
      { path: NAV_ITEMS.queue.path, element: <QueuePage /> },
      { path: NAV_ITEMS.links.path, element: <LinksPage /> },
      { path: NAV_ITEMS.automation.path, element: <AutomationPage /> },
      { path: NAV_ITEMS.schedules.path, element: <SchedulesPage /> },
      { path: NAV_ITEMS.settings.path, element: <SettingsPage /> },
      { path: '*', element: <NotFoundPage /> }
    ]
  }
])
