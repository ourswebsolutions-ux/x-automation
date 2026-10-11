import { useEffect } from 'react'
import type { Id } from '@shared/types/domain'
import type { QueueQuery, ScheduleQuery } from '@shared/types/publishing'
import { useAsync } from '@/hooks/useAsync'
import { relay } from '@/lib/bridge'

/** Reloads whenever the queue, schedules or post links change. */
function usePublishingResource<T>(loader: () => Promise<T>, deps: readonly unknown[]) {
  const state = useAsync(loader, deps)
  const { reload } = state
  useEffect(() => relay.publishing.onChange(reload), [reload])
  return state
}

export function useSchedules(query: ScheduleQuery) {
  return usePublishingResource(() => relay.publishing.list(query), [query.view, query.from, query.to, query.accountId])
}

export function useScheduleCounts() {
  return usePublishingResource(() => relay.publishing.counts(), [])
}

export function useNextSchedule() {
  return usePublishingResource(() => relay.publishing.next(), [])
}

export function useDraftSchedule(draftId: Id | null) {
  return usePublishingResource(() => (draftId ? relay.publishing.forDraft(draftId) : Promise.resolve(null)), [draftId])
}

export function useQueue(query: QueueQuery) {
  return usePublishingResource(() => relay.queue.list(query), [query.view, query.limit])
}

export function useQueueCounts() {
  return usePublishingResource(() => relay.queue.counts(), [])
}

export function useTaskDetails(id: Id | null) {
  return usePublishingResource(() => (id ? relay.queue.details(id) : Promise.resolve(null)), [id])
}

export function usePublishingSettings() {
  return usePublishingResource(() => relay.publishing.getSettings(), [])
}

/** The automation control centre's snapshot (refreshed on queue changes and every few seconds). */
export function useAutomation() {
  const state = usePublishingResource(() => relay.control.snapshot(), [])
  const { reload } = state
  useEffect(() => {
    const timer = setInterval(reload, 5000)
    return () => clearInterval(timer)
  }, [reload])
  return state
}
