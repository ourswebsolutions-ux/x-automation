import { useEffect, useMemo } from 'react'
import type { GenerationHistoryQuery } from '@shared/types/generator'
import { useAsync } from '@/hooks/useAsync'
import { relay } from '@/lib/bridge'
import { useAiOverview } from './ai'
import { useProviders } from './providers'
import { usePreferences } from '@/state/preferences'

export function useGenerationHistory(query: GenerationHistoryQuery) {
  const key = JSON.stringify(query)
  return useAsync(() => relay.generator.history(query), [key])
}

/**
 * Enabled, complete AI text providers the generator can use, with the
 * default first and each provider's last connection test.
 */
export function useTextProviders() {
  const providers = useProviders('openai-compatible')
  const overview = useAiOverview()
  const { preferences } = usePreferences()
  const defaultId = preferences.defaults.textProviderId
  const usable = useMemo(
    () => (providers.data ?? []).filter((p) => p.readiness.state === 'ready').sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId)),
    [providers.data, defaultId]
  )
  const { reload } = providers
  useEffect(() => relay.integrations.onChange(reload), [reload])
  return { loading: !providers.data, usable, all: providers.data ?? [], tests: overview.data?.tests ?? {}, defaultId }
}
