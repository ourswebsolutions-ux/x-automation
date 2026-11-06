import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { PlanId, SubscriptionStatus } from '@shared/types/security'
import { relay } from '@/lib/bridge'

/** A code is on its way to the administrator. Survives moving between pages. */
export interface PendingActivation {
  plan: PlanId
  expiresAt: string
}

interface SubscriptionContextValue {
  status: SubscriptionStatus | null
  active: boolean
  pending: PendingActivation | null
  setPending: (pending: PendingActivation | null) => void
  setStatus: (status: SubscriptionStatus) => void
}

const SubscriptionContext = createContext<SubscriptionContextValue | null>(null)

export function SubscriptionProvider({ children }: { children: ReactNode }) {
  const [status, setStatusState] = useState<SubscriptionStatus | null>(null)
  const [pending, setPending] = useState<PendingActivation | null>(null)
  const setStatus = useCallback((next: SubscriptionStatus) => setStatusState(next), [])

  useEffect(() => {
    relay.subscription.status().then(setStatus, () => undefined)
    return relay.subscription.onAccessChange((snapshot) => setStatus(snapshot.subscription))
  }, [setStatus])

  const value = useMemo(() => ({ status, active: status?.state === 'active', pending, setPending, setStatus }), [status, pending, setStatus])
  return <SubscriptionContext.Provider value={value}>{children}</SubscriptionContext.Provider>
}

export function useSubscription() {
  const context = useContext(SubscriptionContext)
  if (!context) throw new Error('useSubscription must be used inside <SubscriptionProvider>')
  return context
}
