import { useRef } from 'react'

/** Returns the last non-null value — keeps dialog content stable during exit transitions. */
export function useRetained<T>(value: T | null): T | null {
  const ref = useRef(value)
  if (value !== null) ref.current = value
  return ref.current
}
