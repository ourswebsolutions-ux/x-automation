import { useEffect } from 'react'
import type { EngagementQuery } from '@shared/types/links'
import { useAsync } from '@/hooks/useAsync'
import { relay } from '@/lib/bridge'

/** Reloads when links, engagement tasks, schedules or the queue change. */
function useLinksResource<T>(loader: () => Promise<T>, deps: readonly unknown[]) {
  const state = useAsync(loader, deps)
  const { reload } = state
  useEffect(() => relay.publishing.onChange(reload), [reload])
  return state
}

export function useLinks() {
  return useLinksResource(() => relay.links.list(), [])
}

export function useEngagement(query: EngagementQuery) {
  return useLinksResource(() => relay.engagement.list(query), [query.status, query.accountId, query.linkId])
}

export function useEngagementCounts() {
  return useLinksResource(() => relay.engagement.counts(), [])
}

export function useEngagementSettings() {
  return useLinksResource(() => relay.engagement.getSettings(), [])
}
