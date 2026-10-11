import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/cn'

interface PopoverProps {
  open: boolean
  onClose: () => void
  anchorRef: RefObject<HTMLElement | null>
  align?: 'start' | 'end' | 'center'
  offset?: number
  /** Make the popover at least as wide as its anchor (selects). */
  matchWidth?: boolean
  className?: string
  children: ReactNode
  role?: string
  'aria-label'?: string
}

const EDGE = 8

/**
 * Anchored floating surface. Flips above the anchor when space runs out,
 * closes on outside press / Escape, and returns focus to the anchor.
 */
export function Popover({
  open,
  onClose,
  anchorRef,
  align = 'start',
  offset = 6,
  matchWidth = false,
  className,
  children,
  ...aria
}: PopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number; minWidth?: number; origin: string } | null>(null)

  const place = useCallback(() => {
    const anchor = anchorRef.current
    const panel = panelRef.current
    if (!anchor || !panel) return
    const a = anchor.getBoundingClientRect()
    const p = panel.getBoundingClientRect()
    const width = Math.max(p.width, matchWidth ? a.width : 0)
    let left = align === 'start' ? a.left : align === 'end' ? a.right - width : a.left + a.width / 2 - width / 2
    left = Math.min(Math.max(left, EDGE), window.innerWidth - width - EDGE)
    const fitsBelow = a.bottom + offset + p.height <= window.innerHeight - EDGE
    const top = fitsBelow ? a.bottom + offset : Math.max(EDGE, a.top - offset - p.height)
    setPosition({ left, top, minWidth: matchWidth ? a.width : undefined, origin: fitsBelow ? 'top' : 'bottom' })
  }, [anchorRef, align, offset, matchWidth])

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    place()
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
      anchorRef.current?.focus()
    }
    const onReflow = () => place()
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onReflow)
    window.addEventListener('scroll', onReflow, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', onReflow)
      window.removeEventListener('scroll', onReflow, true)
    }
  }, [open, onClose, anchorRef, place])

  if (!open) return null

  return createPortal(
    <div
      ref={panelRef}
      {...aria}
      style={{
        left: position?.left ?? -9999,
        top: position?.top ?? -9999,
        minWidth: position?.minWidth,
        transformOrigin: position?.origin
      }}
      className={cn(
        'fixed z-[150] rounded-lg bg-overlay shadow-popover',
        position ? 'animate-pop-in' : 'invisible',
        className
      )}
    >
      {children}
    </div>,
    document.body
  )
}
