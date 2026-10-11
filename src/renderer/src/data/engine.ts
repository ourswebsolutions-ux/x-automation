import { useEffect } from 'react'
import { useAsync } from '@/hooks/useAsync'
import { relay } from '@/lib/bridge'

/** Engine status; refreshed on every app state change and every few seconds while it is starting. */
export function useEngineStatus() {
  const state = useAsync(() => relay.engine.status(), [])
  const { reload } = state
  useEffect(() => relay.integrations.onChange(reload), [reload])
  useEffect(() => {
    if (state.data?.state !== 'starting' && state.data?.state !== 'stopping') return
    const timer = setInterval(reload, 1000)
    return () => clearInterval(timer)
  }, [state.data?.state, reload])
  return state
}
