import type { BrowserProfile } from '@shared/types/ixbrowser'
import { StatusBadge } from '@/components/ui'

/** Availability and run state as last reported by IX Browser. */
export function ProfileStateBadge({ profile }: { profile: Pick<BrowserProfile, 'availability' | 'runState'> }) {
  if (profile.availability === 'unavailable') return <StatusBadge tone="neutral" variant="outline">Unavailable</StatusBadge>
  if (profile.runState === 'running') {
    return (
      <StatusBadge tone="success" dot pulse>
        Running
      </StatusBadge>
    )
  }
  if (profile.runState === 'closed') return <StatusBadge tone="neutral" dot>Closed</StatusBadge>
  return <StatusBadge tone="neutral" variant="outline">Unknown</StatusBadge>
}
