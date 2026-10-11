import { CircleAlert, CircleCheck, Info, TriangleAlert, X, type LucideIcon } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/cn'

type ToastTone = 'success' | 'info' | 'warning' | 'danger'

export interface ToastOptions {
  title: string
  description?: string
  tone?: ToastTone
  duration?: number
  action?: { label: string; onClick: () => void }
}

interface ToastRecord extends Required<Pick<ToastOptions, 'title' | 'tone' | 'duration'>> {
  id: number
  description?: string
  action?: ToastOptions['action']
}

const ToastContext = createContext<((options: ToastOptions) => void) | null>(null)

const toneIcon: Record<ToastTone, { Icon: LucideIcon; className: string }> = {
  success: { Icon: CircleCheck, className: 'text-success' },
  info: { Icon: Info, className: 'text-info' },
  warning: { Icon: TriangleAlert, className: 'text-warning' },
  danger: { Icon: CircleAlert, className: 'text-danger' }
}

const MAX_VISIBLE = 4

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((toast) => toast.id !== id)), [])

  const toast = useCallback((options: ToastOptions) => {
    const record: ToastRecord = {
      id: nextId.current++,
      title: options.title,
      description: options.description,
      tone: options.tone ?? 'info',
      duration: options.duration ?? 4200,
      action: options.action
    }
    setToasts((list) => [...list, record].slice(-MAX_VISIBLE))
  }, [])

  return (
    <ToastContext.Provider value={toast}>
      {children}
      {createPortal(
        <div
          aria-live="polite"
          aria-label="Notifications"
          className="pointer-events-none fixed bottom-10 right-4 z-[180] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2"
        >
          {toasts.map((record) => (
            <ToastItem key={record.id} record={record} onDismiss={dismiss} />
          ))}
        </div>,
        document.body
      )}
    </ToastContext.Provider>
  )
}

function ToastItem({ record, onDismiss }: { record: ToastRecord; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false)
  const { Icon, className } = toneIcon[record.tone]

  useEffect(() => {
    if (paused) return
    const timer = window.setTimeout(() => onDismiss(record.id), record.duration)
    return () => window.clearTimeout(timer)
  }, [paused, record.id, record.duration, onDismiss])

  return (
    <div
      role="status"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      className="pointer-events-auto flex items-start gap-3 rounded-lg bg-overlay py-3 pl-3.5 pr-2.5 shadow-popover animate-slide-in"
    >
      <Icon size={16} strokeWidth={1.8} className={cn('mt-px shrink-0', className)} aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-sm font-medium text-fg">{record.title}</p>
        {record.description && <p className="text-xs text-fg-subtle text-pretty">{record.description}</p>}
        {record.action && (
          <button
            type="button"
            onClick={() => {
              record.action?.onClick()
              onDismiss(record.id)
            }}
            className="mt-1.5 self-start rounded-xs text-xs font-medium text-accent-text hover:underline focus-ring"
          >
            {record.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => onDismiss(record.id)}
        className="grid size-5 shrink-0 place-items-center rounded-xs text-fg-faint hover:bg-neutral-soft hover:text-fg focus-ring"
      >
        <X size={12} strokeWidth={2} />
      </button>
    </div>
  )
}

export function useToast() {
  const toast = useContext(ToastContext)
  if (!toast) throw new Error('useToast must be used inside <ToastProvider>')
  return useMemo(() => toast, [toast])
}
