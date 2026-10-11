import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/cn'
import { KeyCombo } from './Kbd'

type Side = 'top' | 'bottom' | 'right' | 'left'

interface TooltipProps {
  content: ReactNode
  shortcut?: string[]
  side?: Side
  delay?: number
  children: ReactNode
  className?: string
  disabled?: boolean
}

const GAP = 6
const EDGE = 8

/**
 * Hover/focus tooltip rendered in a portal so it never clips. Works around
 * disabled buttons because the listeners sit on the wrapper.
 */
export function Tooltip({ content, shortcut, side = 'bottom', delay = 380, children, className, disabled }: TooltipProps) {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const timer = useRef<number | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [style, setStyle] = useState<CSSProperties>({ left: -9999, top: -9999 })

  const disabledRef = useRef(disabled)
  disabledRef.current = disabled
  // Focus that follows a click should not pop the tooltip back up.
  const pointerDown = useRef(false)

  const show = () => {
    if (disabledRef.current) return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => !disabledRef.current && setOpen(true), delay)
  }
  const hide = () => {
    window.clearTimeout(timer.current)
    setOpen(false)
  }

  useEffect(() => {
    if (disabled) hide()
  }, [disabled])
  useEffect(() => () => window.clearTimeout(timer.current), [])

  useLayoutEffect(() => {
    if (!open || !anchorRef.current || !tipRef.current) return
    const a = anchorRef.current.getBoundingClientRect()
    const t = tipRef.current.getBoundingClientRect()
    const clampX = (x: number) => Math.min(Math.max(x, EDGE), window.innerWidth - t.width - EDGE)
    const clampY = (y: number) => Math.min(Math.max(y, EDGE), window.innerHeight - t.height - EDGE)
    const positions: Record<Side, { left: number; top: number }> = {
      bottom: { left: clampX(a.left + a.width / 2 - t.width / 2), top: a.bottom + GAP },
      top: { left: clampX(a.left + a.width / 2 - t.width / 2), top: a.top - t.height - GAP },
      right: { left: a.right + GAP, top: clampY(a.top + a.height / 2 - t.height / 2) },
      left: { left: a.left - t.width - GAP, top: clampY(a.top + a.height / 2 - t.height / 2) }
    }
    let chosen = side
    if (side === 'bottom' && a.bottom + GAP + t.height > window.innerHeight - EDGE) chosen = 'top'
    if (side === 'top' && a.top - GAP - t.height < EDGE) chosen = 'bottom'
    setStyle(positions[chosen])
  }, [open, side, content])

  return (
    <>
      <span
        ref={anchorRef}
        className={cn('inline-flex', className)}
        onPointerEnter={show}
        onPointerLeave={() => {
          pointerDown.current = false
          hide()
        }}
        onPointerDown={() => {
          pointerDown.current = true
          hide()
        }}
        onFocus={() => !pointerDown.current && show()}
        onBlur={hide}
      >
        {children}
      </span>
      {open &&
        createPortal(
          <div
            ref={tipRef}
            role="tooltip"
            style={style}
            className={cn(
              'pointer-events-none fixed z-[200] flex max-w-72 items-center gap-2 rounded-sm px-2 py-1',
              'bg-overlay text-xs text-fg shadow-popover animate-fade-in'
            )}
          >
            <span>{content}</span>
            {shortcut && <KeyCombo keys={shortcut} />}
          </div>,
          document.body
        )}
    </>
  )
}
