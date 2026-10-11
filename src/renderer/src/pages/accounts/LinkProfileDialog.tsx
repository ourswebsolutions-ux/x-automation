import { useEffect, useState } from 'react'
import type { Account } from '@shared/types/accounts'
import type { BrowserProfile } from '@shared/types/ixbrowser'
import { Button, Modal, Notice, useToast } from '@/components/ui'
import { errorMessage, relay } from '@/lib/bridge'
import { useRetained } from '@/hooks/useRetained'
import { ProfilePicker } from './ProfilePicker'

interface LinkProfileDialogProps {
  account: Account | null
  profiles: BrowserProfile[]
  accounts: Account[]
  onClose: () => void
}

/** Link an account to a profile, or move its link to another profile. */
export function LinkProfileDialog({ account, profiles, accounts, onClose }: LinkProfileDialogProps) {
  const toast = useToast()
  const shown = useRetained(account)
  const [profileId, setProfileId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!account) return
    setProfileId(null)
    setError(null)
  }, [account])

  const current = shown?.profile ?? null
  const link = async () => {
    if (!account || !profileId) return
    setSaving(true)
    setError(null)
    try {
      const updated = await relay.accounts.link(account.id, profileId)
      toast({ tone: 'success', title: current ? 'Link moved' : 'Profile linked', description: `${updated.label} → ${updated.profile?.name ?? ''}` })
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={Boolean(account)}
      onClose={onClose}
      dismissible={!saving}
      title={current ? `Change profile for “${shown?.label ?? ''}”` : `Link “${shown?.label ?? ''}” to a profile`}
      description="Choose the IX Browser profile this X account is signed in to. Each profile can belong to one account."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={link} loading={saving} disabled={!profileId || profileId === current?.id}>
            {current ? 'Move link' : 'Link profile'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {current && (
          <Notice title={`Currently linked to “${current.name}” (#${current.externalId})`}>
            Moving the link only changes this local record. Neither browser profile is modified.
          </Notice>
        )}
        {error && (
          <Notice tone="warning" title="Could not link">
            {error}
          </Notice>
        )}
        {shown && <ProfilePicker profiles={profiles} accounts={accounts} value={profileId} onChange={setProfileId} selfId={shown.id} />}
      </div>
    </Modal>
  )
}
