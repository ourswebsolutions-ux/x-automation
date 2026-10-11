import { useEffect } from 'react'
import { useAsync } from '@/hooks/useAsync'
import { relay } from '@/lib/bridge'

/**
 * Local account records. Reloads when accounts change and when IX Browser
 * state changes (a sync can rename a linked profile or mark it unavailable).
 */
export function useAccounts() {
  const state = useAsync(() => relay.accounts.list(), [])
  const { reload } = state
  useEffect(() => {
    const offAccounts = relay.accounts.onChange(reload)
    const offIntegrations = relay.integrations.onChange(reload)
    return () => {
      offAccounts()
      offIntegrations()
    }
  }, [reload])
  return state
}

/** One account with its local history. Pass null to load nothing. */
export function useAccountDetails(id: string | null) {
  const state = useAsync(() => (id ? relay.accounts.details(id) : Promise.resolve(null)), [id])
  const { reload } = state
  useEffect(() => {
    if (!id) return
    const offAccounts = relay.accounts.onChange(reload)
    const offIntegrations = relay.integrations.onChange(reload)
    return () => {
      offAccounts()
      offIntegrations()
    }
  }, [id, reload])
  return state
}
