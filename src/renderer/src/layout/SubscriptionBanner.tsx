import { useLocation, useNavigate } from 'react-router'
import type { SubscriptionState } from '@shared/types/security'
import { Button, Notice } from '@/components/ui'
import { settingsPath } from '@/app/navigation'
import { useSubscription } from '@/state/subscription'

const MESSAGES: Record<Exclude<SubscriptionState, 'active'>, { title: string; body: string }> = {
  none: { title: 'X Auto isn’t activated', body: 'You can look around, but publishing, campaigns and AI need a subscription.' },
  expired: { title: 'Your subscription has expired', body: 'Publishing, campaigns and AI are paused until you renew. Your data is safe.' },
  revoked: { title: 'Your subscription was revoked', body: 'Publishing, campaigns and AI are off. Contact the administrator.' },
  stale: { title: 'Your subscription needs checking', body: 'X Auto hasn’t reached the activation service for a while. Connect to the internet and check again, or enter a new activation code.' }
}

export function SubscriptionBanner() {
  const { status, active } = useSubscription()
  const navigate = useNavigate()
  const { pathname, search } = useLocation()
  if (!status || active || `${pathname}${search}` === settingsPath('subscription')) return null
  const message = MESSAGES[status.state as keyof typeof MESSAGES]
  return (
    <Notice
      tone="warning"
      title={message.title}
      className="mb-5"
      actions={
        <Button size="sm" variant="primary" onClick={() => navigate(settingsPath('subscription'))}>
          {status.state === 'stale' ? 'Check now' : 'Activate'}
        </Button>
      }
    >
      {message.body}
    </Notice>
  )
}
