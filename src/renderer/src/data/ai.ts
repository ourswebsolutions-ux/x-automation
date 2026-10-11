import { useEffect } from 'react'
import type { AiUsageQuery } from '@shared/types/ai'
import { useAsync } from '@/hooks/useAsync'
import { relay } from '@/lib/bridge'

/** Last connection test per provider and in-flight requests. */
export function useAiOverview() {
  const state = useAsync(() => relay.ai.overview(), [])
  const { reload } = state
  useEffect(() => relay.integrations.onChange(reload), [reload])
  return state
}

/** The last fetched model list for a provider (never triggers a request). */
export function useCachedModels(providerId: string | null) {
  return useAsync(() => (providerId ? relay.ai.listModels(providerId, false) : Promise.resolve(null)), [providerId])
}

/** Usage rows and totals for a filter; refreshed whenever AI state changes. */
export function useAiUsage(query: AiUsageQuery) {
  const key = JSON.stringify(query)
  const state = useAsync(async () => {
    const [records, summary] = await Promise.all([relay.ai.usage(query), relay.ai.usageSummary({ ...query, limit: undefined })])
    return { records, summary }
  }, [key])
  const { reload } = state
  useEffect(() => relay.integrations.onChange(reload), [reload])
  return state
}
