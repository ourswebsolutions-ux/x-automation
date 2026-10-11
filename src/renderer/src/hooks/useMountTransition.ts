import { useEffect, useState } from 'react'

/**
 * Keeps an element mounted long enough to play its exit transition.
 * `visible` flips one frame after mount so enter transitions run too.
 */
export function useMountTransition(open: boolean, exitMs = 150) {
  const [mounted, setMounted] = useState(open)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (open) {
      setMounted(true)
      const frame = requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)))
      return () => cancelAnimationFrame(frame)
    }
    setVisible(false)
    const timer = window.setTimeout(() => setMounted(false), exitMs)
    return () => window.clearTimeout(timer)
  }, [open, exitMs])

  return { mounted, visible }
}
