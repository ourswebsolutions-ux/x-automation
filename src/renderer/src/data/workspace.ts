import { useEffect } from 'react'
import type { WorkspaceSummary } from '@shared/types/domain'
import { useAsync } from '@/hooks/useAsync'
import { relay } from '@/lib/bridge'
import { usePreferences } from '@/state/preferences'
import { DEMO_SUMMARY } from './demo'

/**
 * Dashboard read model. Demo mode returns the sample dataset; live mode asks
 * the main process, which reads the SQLite repositories.
 */
export function useWorkspaceSummary() {
  const { preferences } = usePreferences()
  const demo = preferences.showDemoData
  const state = useAsync<WorkspaceSummary>(
    () => (demo ? Promise.resolve(DEMO_SUMMARY) : relay.workspace.getSummary()),
    [demo]
  )
  const { reload } = state
  useEffect(() => (demo ? undefined : relay.publishing.onChange(reload)), [demo, reload])
  return { ...state, demo }
}
