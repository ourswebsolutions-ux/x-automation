import { useLayoutEffect, useRef, useState } from 'react'

/**
 * Measures the active child inside a container so a single indicator element
 * can glide between options (tabs underline, segmented thumb).
 */
export function useIndicator<T extends HTMLElement>(activeKey: string, deps: readonly unknown[] = []) {
  const containerRef = useRef<T>(null)
  const [rect, setRect] = useState<{ left: number; width: number } | null>(null)

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const measure = () => {
      const active = container.querySelector<HTMLElement>(`[data-key="${CSS.escape(activeKey)}"]`)
      setRect(active ? { left: active.offsetLeft, width: active.offsetWidth } : null)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [activeKey, ...deps])

  return { containerRef, rect }
}
