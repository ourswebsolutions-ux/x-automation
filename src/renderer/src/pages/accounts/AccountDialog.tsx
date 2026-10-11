import { AtSign, Link2 } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import type { Account } from '@shared/types/accounts'
import type { BrowserProfile } from '@shared/types/ixbrowser'
import { Button, Checkbox, Field, Input, Modal, Notice, Switch, Textarea, useToast } from '@/components/ui'
import { errorMessage, relay } from '@/lib/bridge'
import { ProfilePicker } from './ProfilePicker'

const HANDLE = /^@?[A-Za-z0-9_]{1,15}$/
const NOTES_MAX = 4000

interface AccountDialogProps {
  open: boolean
  /** Edit this account; create a new one when null. */
  account: Account | null
  /** Pre-selected profile when creating from a profile row. */
  initialProfileId?: string | null
  profiles: BrowserProfile[]
  accounts: Account[]
  onClose: () => void
  onSaved: (account: Account) => void
}

/** Create or edit a local account record. */
export function AccountDialog({ open, account, initialProfileId = null, profiles, accounts, onClose, onSaved }: AccountDialogProps) {
  const toast = useToast()
  const ids = { label: useId(), handle: useId(), confirm: useId(), notes: useId(), enabled: useId(), profile: useId() }
  const [label, setLabel] = useState('')
  const [handle, setHandle] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [notes, setNotes] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [profileId, setProfileId] = useState<string | null>(null)
  const [labelTouched, setLabelTouched] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setLabel(account?.label ?? (initialProfileId ? (profiles.find((p) => p.id === initialProfileId)?.name ?? '') : ''))
    setHandle(account?.handle ?? '')
    setConfirm(account?.identity === 'confirmed')
    setNotes(account?.notes ?? '')
    setEnabled(account?.enabled ?? true)
    setProfileId(account ? null : initialProfileId)
    setLabelTouched(Boolean(account))
    setSubmitted(false)
    setServerError(null)
    // Only reset when the dialog opens or targets another record.
  }, [open, account?.id, initialProfileId])

  const trimmedHandle = handle.trim()
  const labelError = !label.trim() ? 'Give the account a label.' : label.trim().length > 80 ? 'Labels can be up to 80 characters.' : null
  const handleError = trimmedHandle && !HANDLE.test(trimmedHandle) ? 'An X username has 1–15 letters, numbers or underscores.' : null
  const notesError = notes.length > NOTES_MAX ? 'Notes can be up to 4,000 characters.' : null
  const invalid = Boolean(labelError || handleError || notesError)
  const handleChanged = account && trimmedHandle.replace(/^@/, '').toLowerCase() !== (account.handle ?? '').toLowerCase()

  const chooseProfile = (id: string | null) => {
    setProfileId(id)
    // Suggest the profile name as a label until the user types their own.
    if (!labelTouched) setLabel(id ? (profiles.find((p) => p.id === id)?.name ?? '') : '')
  }

  const save = async () => {
    setSubmitted(true)
    if (invalid || saving) return
    setSaving(true)
    setServerError(null)
    const input = {
      label: label.trim(),
      handle: trimmedHandle || null,
      confirmIdentity: Boolean(trimmedHandle) && confirm,
      notes,
      enabled
    }
    try {
      const saved = account ? await relay.accounts.update(account.id, input) : await relay.accounts.create({ ...input, profileId })
      toast({ tone: 'success', title: account ? 'Account updated' : 'Account created', description: saved.label })
      onSaved(saved)
    } catch (error) {
      setServerError(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!saving}
      size="md"
      title={account ? 'Edit account' : 'New account'}
      description={
        account
          ? 'Changes are stored locally. Nothing is sent to X.'
          : 'A local record for an X account, optionally linked to one of your IX Browser profiles.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={save} disabled={submitted && invalid}>
            {account ? 'Save changes' : 'Create account'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        {serverError && (
          <Notice tone="warning" title="Not saved">
            {serverError}
          </Notice>
        )}

        <Field label="Label" htmlFor={ids.label} error={submitted ? labelError : null} hint="Your own name for this account, e.g. a brand or client.">
          <Input
            id={ids.label}
            data-autofocus
            value={label}
            maxLength={120}
            invalid={submitted && Boolean(labelError)}
            onChange={(event) => {
              setLabel(event.target.value)
              setLabelTouched(true)
            }}
          />
        </Field>

        <Field
          label="X username"
          htmlFor={ids.handle}
          error={handleError}
          aside={<span className="text-2xs text-fg-faint">Optional</span>}
          hint="Never read from the browser profile. Leave it empty if you are not sure."
        >
          <Input
            id={ids.handle}
            icon={AtSign}
            value={handle}
            maxLength={16}
            spellCheck={false}
            autoComplete="off"
            placeholder="username"
            invalid={Boolean(handleError)}
            onChange={(event) => {
              setHandle(event.target.value.replace(/\s/g, ''))
              if (account?.identity === 'confirmed') setConfirm(false)
            }}
          />
        </Field>

        <label htmlFor={ids.confirm} className="-mt-1 flex items-start gap-2.5 rounded-md border border-line bg-surface-1 px-3 py-2.5">
          <Checkbox id={ids.confirm} checked={confirm && Boolean(trimmedHandle)} disabled={!trimmedHandle || Boolean(handleError)} onChange={setConfirm} className="mt-px" />
          <span className="flex flex-col gap-0.5">
            <span className={trimmedHandle ? 'text-sm text-fg' : 'text-sm text-fg-subtle'}>I confirm this is the X account signed in to this profile</span>
            <span className="text-xs text-fg-subtle">
              Axora Relay can’t check this with X. Without confirmation the username is shown as “Not verified”.
              {handleChanged && account?.identity === 'confirmed' && ' Changing the username clears the earlier confirmation.'}
            </span>
          </span>
        </label>

        {!account && (
          <Field label="Browser profile" htmlFor={ids.profile} aside={<span className="text-2xs text-fg-faint">Optional</span>}>
            <ProfilePicker id={ids.profile} profiles={profiles} accounts={accounts} value={profileId} onChange={chooseProfile} allowNone />
          </Field>
        )}

        <Field
          label="Notes"
          htmlFor={ids.notes}
          error={notesError}
          aside={<span className="tabular text-2xs text-fg-faint">{notes.length > NOTES_MAX * 0.8 ? `${notes.length}/${NOTES_MAX}` : ''}</span>}
        >
          <Textarea id={ids.notes} rows={3} value={notes} invalid={Boolean(notesError)} onChange={(event) => setNotes(event.target.value)} placeholder="Anything worth remembering about this account" />
        </Field>

        <div className="flex items-start justify-between gap-4 rounded-md border border-line bg-surface-1 px-3 py-2.5">
          <label htmlFor={ids.enabled} className="flex flex-col gap-0.5">
            <span className="text-sm text-fg">Available for task assignment</span>
            <span className="text-xs text-fg-subtle">A local setting for future scheduling. It doesn’t change anything on X.</span>
          </label>
          <Switch id={ids.enabled} checked={enabled} onChange={setEnabled} />
        </div>

        {account?.profile && (
          <p className="flex items-center gap-1.5 text-xs text-fg-subtle">
            <Link2 size={12} /> Linked to “{account.profile.name}” (#{account.profile.externalId}). Change the link from the details panel.
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
