import { useEffect, useState } from 'react'
import type { Account } from '@shared/types/accounts'
import { Button, Field, Modal, Select, Textarea, useToast } from '@/components/ui'
import { TagInput } from '@/components/feature/TagInput'
import { errorMessage, relay } from '@/lib/bridge'
import { pluralize } from '@/lib/format'

interface AddLinksDialogProps {
  open: boolean
  accounts: Account[]
  knownTags: string[]
  onClose: () => void
}

/** Paste links to posts on X (one per line). Duplicates and non-post links are reported, not added. */
export function AddLinksDialog({ open, accounts, knownTags, onClose }: AddLinksDialogProps) {
  const toast = useToast()
  const [text, setText] = useState('')
  const [accountId, setAccountId] = useState<string>('match')
  const [tags, setTags] = useState<string[]>([])
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setText('')
    setAccountId('match')
    setTags([])
    setNotes('')
  }, [open])

  const save = async () => {
    setSaving(true)
    try {
      const r = await relay.links.add({ text, accountId: accountId === 'match' ? null : accountId, tags, notes })
      const extra = [r.duplicates.length ? `${pluralize(r.duplicates.length, 'link')} already saved` : '', r.rejected.length ? `${pluralize(r.rejected.length, 'line')} skipped: ${r.rejected[0]!.reason}` : '']
        .filter(Boolean)
        .join(' · ')
      toast({ tone: r.added.length ? (r.rejected.length ? 'warning' : 'success') : 'warning', title: r.added.length ? `${pluralize(r.added.length, 'link')} added` : 'No new links', description: extra || undefined, duration: 8000 })
      if (r.added.length) onClose()
    } catch (error) {
      toast({ tone: 'danger', title: 'Links not added', description: errorMessage(error) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!saving}
      size="lg"
      title="Add post links"
      description="Paste links to posts on x.com or twitter.com, one per line. They are saved on this device only."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!text.trim()} onClick={save}>
            Add links
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Links" htmlFor="links-text">
          <Textarea id="links-text" rows={7} value={text} spellCheck={false} placeholder={'https://x.com/username/status/1234567890\nhttps://x.com/another/status/9876543210'} onChange={(e) => setText(e.target.value)} className="font-mono text-xs" />
        </Field>
        <Field label="Account" htmlFor="links-account" hint="Matching uses the username in each link and only links to your accounts with that username.">
          <Select<string>
            id="links-account"
            value={accountId}
            onChange={setAccountId}
            options={[{ value: 'match', label: 'Match by username in the link' }, ...accounts.map((a) => ({ value: a.id, label: a.label, description: a.handle ? `@${a.handle}` : undefined }))]}
          />
        </Field>
        <Field label="Tags" htmlFor="links-tags" aside={<span className="text-2xs text-fg-faint">Optional</span>}>
          <TagInput id="links-tags" value={tags} onChange={setTags} suggestions={knownTags} />
        </Field>
        <Field label="Notes" htmlFor="links-notes" aside={<span className="text-2xs text-fg-faint">Optional</span>}>
          <Textarea id="links-notes" rows={2} value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
