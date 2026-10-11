import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import type { IntegrationStatus } from '@shared/types/integrations'
import type { AppInfo, SecurityPosture } from '@shared/types/system'
import { useAsync, type AsyncResource } from '@/hooks/useAsync'
import { relay } from '@/lib/bridge'

interface SystemContextValue {
  appInfo: AsyncResource<AppInfo>
  security: AsyncResource<SecurityPosture>
  integrations: AsyncResource<IntegrationStatus[]>
}

const SystemContext = createContext<SystemContextValue | null>(null)

/** Real, installation-level facts: version, isolation flags, integration states. */
export function SystemProvider({ children }: { children: ReactNode }) {
  const appInfo = useAsync(() => relay.app.getInfo(), [])
  const integrations = useAsync(() => relay.integrations.list(), [])
  const security = useAsync(() => relay.app.getSecurityPosture(), [])

  // Provider configs and credentials change from several screens — refresh on every change.
  const { reload: reloadIntegrations } = integrations
  const { reload: reloadSecurity } = security
  useEffect(
    () =>
      relay.integrations.onChange(() => {
        reloadIntegrations()
        reloadSecurity()
      }),
    [reloadIntegrations, reloadSecurity]
  )

  const value = useMemo(() => ({ appInfo, security, integrations }), [appInfo, security, integrations])
  return <SystemContext.Provider value={value}>{children}</SystemContext.Provider>
}

export function useSystem() {
  const context = useContext(SystemContext)
  if (!context) throw new Error('useSystem must be used inside <SystemProvider>')
  return context
}
