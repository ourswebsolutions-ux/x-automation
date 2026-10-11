import { Bell, BellOff, CheckCheck, Trash2 } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { EmptyState, IconButton, Popover, StatusDot, Tooltip } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatRelative } from '@/lib/format'
import { useNotifications, type AppNotification } from '@/state/notifications'

const toneFor: Record<AppNotification['tone'], 'info' | 'success' | 'warning' | 'danger'> = {
  info: 'info',
  success: 'success',
  warning: 'warning',
  danger: 'danger'
}

export function NotificationCenter() {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const { items, unread, markRead, markAllRead, clear } = useNotifications()
  const navigate = useNavigate()
  const close = useCallback(() => setOpen(false), [])

  const openItem = (item: AppNotification) => {
    markRead(item.id)
    if (item.to) {
      navigate(item.to)
      setOpen(false)
    }
  }

  return (
    <>
      <Tooltip content="Notifications" disabled={open}>
        <button
          ref={anchorRef}
          type="button"
          aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className={cn(
            'no-drag relative grid size-7 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-neutral-soft hover:text-fg focus-ring',
            open && 'bg-neutral-soft text-fg'
          )}
        >
          <Bell size={15} strokeWidth={1.8} />
          {unread > 0 && (
            <span className="absolute right-1 top-1 size-[7px] rounded-full border-[1.5px] border-canvas bg-accent" aria-hidden />
          )}
        </button>
      </Tooltip>

      <Popover open={open} onClose={close} anchorRef={anchorRef} align="end" className="w-[360px]" aria-label="Notifications">
        <div className="flex h-11 items-center gap-2 border-b border-line pl-4 pr-2">
          <h2 className="flex-1 text-sm font-medium text-fg">Notifications</h2>
          <IconButton icon={CheckCheck} label="Mark all as read" size="sm" disabled={!unread} onClick={markAllRead} />
          <IconButton icon={Trash2} label="Clear all" size="sm" disabled={!items.length} onClick={clear} />
        </div>
        {items.length === 0 ? (
          <EmptyState size="sm" icon={BellOff} title="You're all caught up" description="Task failures, reminders and system notices will appear here." />
        ) : (
          <ul className="max-h-[420px] overflow-y-auto p-1">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => openItem(item)}
                  className="flex w-full gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-neutral-soft focus-ring"
                >
                  <StatusDot tone={toneFor[item.tone]} className="mt-[7px]" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-baseline gap-2">
                      <span className={cn('flex-1 truncate text-sm', item.read ? 'text-fg-muted' : 'font-medium text-fg')}>{item.title}</span>
                      <span className="shrink-0 text-2xs text-fg-faint">{formatRelative(item.at)}</span>
                    </span>
                    {item.body && <span className="text-xs text-fg-subtle text-pretty">{item.body}</span>}
                  </span>
                  {!item.read && <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-accent" aria-label="Unread" />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Popover>
    </>
  )
}
