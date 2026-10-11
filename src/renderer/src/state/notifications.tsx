import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { CURRENT_PHASE } from '@shared/config/roadmap'
import type { NotificationEvent } from '@shared/types/preferences'
import { usePreferences } from './preferences'

export interface AppNotification {
  id: number
  title: string
  body?: string
  tone: 'info' | 'success' | 'warning' | 'danger'
  at: string
  read: boolean
  /** Route to open when the notification is clicked. */
  to?: string
}

type NewNotification = Omit<AppNotification, 'id' | 'at' | 'read'> & {
  /** Which preference governs this notification. Defaults to system notices. */
  event?: NotificationEvent
}

interface NotificationsContextValue {
  items: AppNotification[]
  unread: number
  push: (notification: NewNotification) => void
  markRead: (id: number) => void
  markAllRead: () => void
  clear: () => void
}

const NotificationsContext = createContext<NotificationsContextValue | null>(null)

let nextId = 1
const make = ({ event: _event, ...n }: NewNotification): AppNotification => ({
  ...n,
  id: nextId++,
  at: new Date().toISOString(),
  read: false
})

/** In-app notification centre. Only real application events are pushed here. */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { preferences } = usePreferences()
  const prefsRef = useRef(preferences)
  prefsRef.current = preferences

  const [items, setItems] = useState<AppNotification[]>(() =>
    preferences.notifications.systemNotices.inApp
      ? [
          make({
            tone: 'info',
            title: `Phase ${CURRENT_PHASE}: AI automation`,
            body: 'Describe the posts you want, choose profiles and start once — Axora Relay writes, illustrates, schedules and publishes them, or waits for your approval.',
            to: '/automation'
          })
        ]
      : []
  )

  // Respect the in-app channel preference for each event type.
  const push = useCallback((n: NewNotification) => {
    if (!prefsRef.current.notifications[n.event ?? 'systemNotices'].inApp) return
    setItems((list) => [make(n), ...list].slice(0, 50))
  }, [])
  const markRead = useCallback((id: number) => setItems((list) => list.map((n) => (n.id === id ? { ...n, read: true } : n))), [])
  const markAllRead = useCallback(() => setItems((list) => list.map((n) => ({ ...n, read: true }))), [])
  const clear = useCallback(() => setItems([]), [])

  const value = useMemo(
    () => ({ items, unread: items.filter((n) => !n.read).length, push, markRead, markAllRead, clear }),
    [items, push, markRead, markAllRead, clear]
  )
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>
}

export function useNotifications() {
  const context = useContext(NotificationsContext)
  if (!context) throw new Error('useNotifications must be used inside <NotificationsProvider>')
  return context
}
