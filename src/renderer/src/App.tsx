import { useEffect } from 'react'
import { RouterProvider } from 'react-router'
import { ErrorState, ToastProvider, useToast } from '@/components/ui'
import { RESTORED_FLAG } from '@/pages/settings/BackupSection'
import { useAsync } from '@/hooks/useAsync'
import { hasBridge, relay } from '@/lib/bridge'
import { BrandMark } from '@/layout/BrandMark'
import { NotificationsProvider } from '@/state/notifications'
import { PreferencesProvider } from '@/state/preferences'
import { SystemProvider } from '@/state/system'
import { UiProvider } from '@/state/ui'
import { router } from '@/app/router'

function Splash() {
  return (
    <div className="grid h-full place-items-center bg-canvas" role="status" aria-label="Loading">
      <div className="animate-pulse opacity-60">
        <BrandMark size={32} />
      </div>
    </div>
  )
}

/** Confirms a completed restore after the window reloads. */
function useRestoreConfirmation() {
  const toast = useToast()
  useEffect(() => {
    try {
      const fileName = sessionStorage.getItem(RESTORED_FLAG)
      if (!fileName) return
      sessionStorage.removeItem(RESTORED_FLAG)
      toast({ tone: 'success', title: 'Backup restored', description: `Data from ${fileName} is now active. A recovery backup was saved first.`, duration: 8000 })
    } catch {
      // Storage unavailable — nothing to confirm.
    }
  }, [toast])
}

function Bootstrap() {
  const preferences = useAsync(() => relay.preferences.get(), [])
  useRestoreConfirmation()

  if (preferences.status === 'error') {
    return (
      <div className="grid h-full place-items-center bg-canvas">
        <ErrorState title="Preferences could not be loaded" error={preferences.error} onRetry={preferences.reload} />
      </div>
    )
  }
  if (!preferences.data) return <Splash />

  return (
    <PreferencesProvider initial={preferences.data}>
      <SystemProvider>
        <NotificationsProvider>
          <UiProvider>
            <RouterProvider router={router} />
          </UiProvider>
        </NotificationsProvider>
      </SystemProvider>
    </PreferencesProvider>
  )
}

export function App() {
  if (!hasBridge) {
    return (
      <div className="grid h-full place-items-center bg-canvas">
        <ErrorState
          title="Desktop bridge unavailable"
          error="This interface must run inside the X Auto desktop app. Start it with “npm run dev”."
        />
      </div>
    )
  }
  return (
    <ToastProvider>
      <Bootstrap />
    </ToastProvider>
  )
}
