import { useCallback } from 'react'
import { useSearchParams } from 'react-router'

/** A string state stored in the URL query, so search results are linkable. */
export function useQueryParam(key: string): [string, (value: string) => void] {
  const [params, setParams] = useSearchParams()
  const value = params.get(key) ?? ''
  const setValue = useCallback(
    (next: string) =>
      setParams(
        (current) => {
          const copy = new URLSearchParams(current)
          if (next) copy.set(key, next)
          else copy.delete(key)
          return copy
        },
        { replace: true }
      ),
    [key, setParams]
  )
  return [value, setValue]
}
