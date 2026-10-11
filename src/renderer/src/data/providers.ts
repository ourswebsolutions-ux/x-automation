import { useEffect } from 'react'
import type { ProviderKind } from '@shared/types/providers'
import { useAsync } from '@/hooks/useAsync'
import { relay } from '@/lib/bridge'

/** Provider configurations, refreshed whenever any provider or key changes. */
export function useProviders(kind?: ProviderKind) {
  const state = useAsync(() => relay.providers.list(kind), [kind])
  const { reload } = state
  useEffect(() => relay.integrations.onChange(reload), [reload])
  return state
}

/** Whether OS-backed credential storage is usable, and how many keys are stored. */
export function useCredentialStatus() {
  const state = useAsync(() => relay.credentials.status(), [])
  const { reload } = state
  useEffect(() => relay.integrations.onChange(reload), [reload])
  return state
}
