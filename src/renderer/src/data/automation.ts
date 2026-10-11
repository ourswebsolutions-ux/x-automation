import { useEffect } from 'react'
import type { Id } from '@shared/types/domain'
import { useAsync } from '@/hooks/useAsync'
import { relay } from '@/lib/bridge'

/** Reloads on queue/run changes (and every few seconds while something is active). */
function useRunsResource<T>(loader: () => Promise<T>, deps: readonly unknown[], poll = 0) {
  const state = useAsync(loader, deps)
  const { reload } = state
  useEffect(() => relay.publishing.onChange(reload), [reload])
  useEffect(() => {
    if (!poll) return
    const timer = setInterval(reload, poll)
    return () => clearInterval(timer)
  }, [reload, poll])
  return state
}

export function useActiveRun() {
  return useRunsResource(() => relay.runs.active(), [], 5000)
}

export function useRunDetails(id: Id | null) {
  return useRunsResource(() => (id ? relay.runs.details(id) : Promise.resolve(null)), [id], 5000)
}

export function useRuns() {
  return useRunsResource(() => relay.runs.list(), [])
}

export function usePresets() {
  return useRunsResource(() => relay.presets.list(), [])
}
