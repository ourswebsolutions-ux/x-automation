import { useEffect } from 'react'
import { useNavigate } from 'react-router'
import { useToast } from '@/components/ui'
import { relay } from '@/lib/bridge'
import { useNotifications } from '@/state/notifications'

/**
 * Shows notices raised by the main process (publishing results, reminders,
 * missed posts) as a toast and in the notification centre, and follows
 * desktop-notification clicks to the right page.
 */
export function NoticeBridge() {
  const toast = useToast()
  const { push } = useNotifications()
  const navigate = useNavigate()

  useEffect(() => {
    const offNotice = relay.notices.onNotice((notice) => {
      push({ tone: notice.tone, title: notice.title, body: notice.body, to: notice.to, event: notice.event })
      toast({ tone: notice.tone === 'info' ? 'info' : notice.tone, title: notice.title, description: notice.body, duration: notice.tone === 'success' || notice.tone === 'info' ? 5000 : 9000 })
    })
    const offNavigate = relay.notices.onNavigate((route) => navigate(route))
    void relay.notices.ready()
    return () => {
      offNotice()
      offNavigate()
    }
  }, [push, toast, navigate])

  return null
}
