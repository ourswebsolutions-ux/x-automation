import { X } from 'lucide-react'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/cn'
import { useMountTransition } from '@/hooks/useMountTransition'
import { IconButton } from './IconButton'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
  /** Prevents closing via Escape / backdrop while work is in progress. */
  dismissible?: boolean
  className?: string
}

/** Open dialogs, topmost last — only the top one reacts to Escape. */
const modalStack: symbol[] = []

const widths = { sm: 'max-w-[420px]', md: 'max-w-[560px]', lg: 'max-w-[720px]', xl: 'max-w-[980px]' }
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Modal dialog with focus trap, Escape / backdrop dismissal and focus restore. */
export function Modal({ open, onClose, title, description, children, footer, size = 'md', dismissible = true, className }: ModalProps) {
  const { mounted, visible } = useMountTransition(open, 160)
  const dialogRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  const titleId = useId()
  const descriptionId = useId()

  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const dismissibleRef = useRef(dismissible)
  dismissibleRef.current = dismissible

  // Escape is handled at document level so it works wherever focus is.
  useEffect(() => {
    if (!open) return
    const token = Symbol('modal')
    modalStack.push(token)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || modalStack[modalStack.length - 1] !== token || event.defaultPrevented) return
      event.preventDefault()
      if (dismissibleRef.current) onCloseRef.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      modalStack.splice(modalStack.indexOf(token), 1)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement as HTMLElement | null
    const frame = requestAnimationFrame(() => {
      const dialog = dialogRef.current
      const preferred = dialog?.querySelector<HTMLElement>('[data-autofocus]') ?? dialog?.querySelector<HTMLElement>(FOCUSABLE)
      ;(preferred ?? dialog)?.focus()
    })
    return () => {
      cancelAnimationFrame(frame)
      restoreRef.current?.focus?.()
    }
  }, [open])

  if (!mounted) return null

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Tab') return
    const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-start justify-center overflow-y-auto px-4 pb-10 pt-[12vh]" onKeyDown={onKeyDown}>
      <div
        aria-hidden
        onClick={dismissible ? onClose : undefined}
        className={cn('fixed inset-0 bg-scrim transition-opacity duration-150', visible ? 'opacity-100' : 'opacity-0')}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cn(
          'relative flex w-full flex-col rounded-xl bg-overlay shadow-dialog outline-none',
          'transition-[opacity,transform] duration-200 ease-out',
          visible ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-2 scale-[0.985] opacity-0',
          widths[size],
          className
        )}
      >
        <header className="flex items-start gap-3 px-5 pb-1 pt-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 id={titleId} className="text-base font-semibold tracking-[-0.01em] text-fg">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="text-sm text-fg-subtle text-pretty">
                {description}
              </p>
            )}
          </div>
          {dismissible && <IconButton icon={X} label="Close" size="sm" onClick={onClose} className="-mr-1.5" showTooltip={false} />}
        </header>
        {children && <div className="px-5 py-4">{children}</div>}
        {footer && (
          <footer className="flex items-center justify-end gap-2 rounded-b-xl border-t border-line bg-surface-1/50 px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body
  )
}
