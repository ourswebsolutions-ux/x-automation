import { useCallback, useEffect, useRef, useState } from 'react'

export type AsyncState<T> =
  | { status: 'loading'; data: T | undefined; error: undefined }
  | { status: 'success'; data: T; error: undefined }
  | { status: 'error'; data: T | undefined; error: unknown }

export type AsyncResource<T> = AsyncState<T> & { reload: () => void; setData: (data: T) => void }

/**
 * Runs an async loader and tracks loading / success / error.
 * `reload` re-runs it while keeping the previous data visible.
 */
export function useAsync<T>(loader: () => Promise<T>, deps: readonly unknown[]): AsyncResource<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading', data: undefined, error: undefined })
  const generation = useRef(0)

  const run = useCallback(loader, deps)

  const reload = useCallback(() => {
    const current = ++generation.current
    setState((prev) => ({ status: 'loading', data: prev.data, error: undefined }))
    run().then(
      (data) => current === generation.current && setState({ status: 'success', data, error: undefined }),
      (error: unknown) => current === generation.current && setState((prev) => ({ status: 'error', data: prev.data, error }))
    )
  }, [run])

  useEffect(() => {
    reload()
  }, [reload])

  return { ...state, reload, setData: (data: T) => setState({ status: 'success', data, error: undefined }) }
}
