import { useEffect } from 'react'
import { useAsync } from '@/hooks/useAsync'
import { relay } from '@/lib/bridge'

export function useProxies() {
  const state = useAsync(() => relay.proxies.list(), [])
  const { reload } = state
  useEffect(() => relay.integrations.onChange(reload), [reload])
  return state
}

export function useProxyAssignments() {
  const state = useAsync(() => relay.proxies.assignments(), [])
  const { reload } = state
  useEffect(() => relay.integrations.onChange(reload), [reload])
  return state
}
