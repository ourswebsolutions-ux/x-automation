import { useEffect, useState } from 'react'
import type { SyncProgress } from '@shared/types/ixbrowser'
import { useAsync } from '@/hooks/useAsync'
import { relay } from '@/lib/bridge'

/** Connection, counts and sync state. Refreshes on every integration change. */
export function useIxOverview() {
  const state = useAsync(() => relay.ixbrowser.overview(), [])
  const { reload } = state
  useEffect(() => relay.integrations.onChange(reload), [reload])
  return state
}

/** Locally stored profiles (from the last sync), refreshed on change. */
export function useBrowserProfiles() {
  const state = useAsync(() => relay.ixbrowser.profiles(), [])
  const { reload } = state
  useEffect(() => relay.integrations.onChange(reload), [reload])
  return state
}

export function useSyncHistory() {
  const state = useAsync(() => relay.ixbrowser.syncHistory(), [])
  const { reload } = state
  useEffect(() => relay.integrations.onChange(reload), [reload])
  return state
}

/** Live progress of the running sync, or null. */
export function useSyncProgress(active: boolean) {
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  useEffect(() => relay.ixbrowser.onSyncProgress(setProgress), [])
  useEffect(() => {
    if (!active) setProgress(null)
  }, [active])
  return progress
}
