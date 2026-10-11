import { useEffect, useMemo } from 'react'
import type { AssetQuery } from '@shared/types/images'
import { useAsync } from '@/hooks/useAsync'
import { relay } from '@/lib/bridge'
import { useProviders } from './providers'
import { usePreferences } from '@/state/preferences'

/** Library images, refreshed whenever the library changes. */
export function useAssets(query: AssetQuery) {
  const key = JSON.stringify(query)
  const state = useAsync(() => relay.assets.list(query), [key])
  const { reload } = state
  useEffect(() => relay.integrations.onChange(reload), [reload])
  return state
}

/** Enabled, complete image providers (the default first). */
export function useImageProviders() {
  const providers = useProviders('image')
  const { preferences } = usePreferences()
  const defaultId = preferences.defaults.imageProviderId
  const usable = useMemo(
    () => (providers.data ?? []).filter((p) => p.readiness.state === 'ready').sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId)),
    [providers.data, defaultId]
  )
  return { loading: !providers.data, usable, all: providers.data ?? [], defaultId }
}
