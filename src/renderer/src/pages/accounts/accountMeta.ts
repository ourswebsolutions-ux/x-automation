import type { Account, AccountIdentity, AccountLinkState } from '@shared/types/accounts'
import type { Tone } from '@/components/ui'

export function linkState(account: Account): AccountLinkState {
  if (!account.profile) return 'not-linked'
  return account.profile.availability === 'available' ? 'linked' : 'profile-unavailable'
}

export const LINK_STATE: Record<AccountLinkState, { label: string; tone: Tone; description: string }> = {
  linked: { label: 'Linked', tone: 'success', description: 'Linked to a profile IX Browser reported in the last sync' },
  'not-linked': { label: 'Not linked', tone: 'neutral', description: 'No browser profile is associated with this record' },
  'profile-unavailable': {
    label: 'Profile missing',
    tone: 'warning',
    description: 'The linked profile was not reported by the last IX Browser sync'
  }
}

export const IDENTITY: Record<AccountIdentity, { label: string; tone: Tone; description: string }> = {
  unknown: { label: 'Username unknown', tone: 'neutral', description: 'No X username recorded. Profile names are never treated as usernames.' },
  unverified: {
    label: 'Not verified',
    tone: 'warning',
    description: 'Entered by you but not confirmed. X Auto has no way to check it against X.'
  },
  confirmed: {
    label: 'Confirmed by you',
    tone: 'info',
    description: 'You confirmed this is the X account signed in to the linked profile. It was not verified with X.'
  }
}

/** "@name" when a username is recorded, otherwise null. */
export const displayHandle = (account: Pick<Account, 'handle'>) => (account.handle ? `@${account.handle}` : null)
