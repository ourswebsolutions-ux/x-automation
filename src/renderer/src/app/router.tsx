import { createHashRouter, Navigate, useRouteError, useSearchParams } from 'react-router'
import { ErrorState } from '@/components/ui'
import { AppShell } from '@/layout/AppShell'
import { AccountsPage } from '@/pages/accounts/AccountsPage'
import { DashboardPage } from '@/pages/dashboard/DashboardPage'
import { LinksPage } from '@/pages/links/LinksPage'
import { CampaignsPage } from '@/pages/automation/CampaignsPage'
import { CreatePostPage } from '@/pages/create/CreatePostPage'
import { NotFoundPage } from '@/pages/NotFoundPage'
import { SettingsPage } from '@/pages/settings/SettingsPage'
import { usePreferences } from '@/state/preferences'
import { NAV_ITEMS } from './navigation'

function StartPage() {
  const { preferences } = usePreferences()
  return <Navigate to={NAV_ITEMS[preferences.startPage].path} replace />
}

/**
 * Addresses of the pages that were merged into Create Post and Campaign Automation (bookmarks,
 * notifications, older links) lead to the page that now holds them, keeping what they pointed at.
 */
function Moved({ to, keep = [], rename = {}, add = {} }: { to: string; keep?: string[]; rename?: Record<string, string>; add?: Record<string, string> }) {
  const [params] = useSearchParams()
  const next = new URLSearchParams(add)
  for (const k of keep) {
    const v = params.get(k)
    if (v) next.set(k, v)
  }
  for (const [from, as] of Object.entries(rename)) {
    const v = params.get(from)
    if (v) next.set(as, v)
  }
  const qs = next.toString()
  return <Navigate to={`${to}${qs ? `?${qs}` : ''}`} replace />
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
      { path: NAV_ITEMS.create.path, element: <CreatePostPage /> },
      { path: NAV_ITEMS.campaigns.path, element: <CampaignsPage /> },
      { path: NAV_ITEMS.links.path, element: <LinksPage /> },
      { path: NAV_ITEMS.settings.path, element: <SettingsPage /> },
      // Merged pages
      { path: '/posts', element: <Moved to="/create" keep={['draft']} /> },
      { path: '/generator', element: <Moved to="/create" add={{ mode: 'ai' }} /> },
      { path: '/automation', element: <Moved to="/campaigns" keep={['run', 'preset']} /> },
      { path: '/automation-schedule', element: <Moved to="/campaigns" /> },
      { path: '/scheduler', element: <Moved to="/campaigns" add={{ view: 'scheduled' }} /> },
      { path: '/queue', element: <Moved to="/campaigns" add={{ view: 'queue' }} rename={{ view: 'queue' }} /> },
      { path: '*', element: <NotFoundPage /> }
    ]
  }
])
