import { ExternalLink } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { TaskView } from '@shared/types/publishing'
import { Button, Field, Input, Modal, SegmentedControl, useToast } from '@/components/ui'
import { errorMessage, relay } from '@/lib/bridge'

interface ReviewDialogProps {
  task: Pick<TaskView, 'id' | 'accountHandle' | 'accountLabel' | 'draftPreview' | 'error'> | null
  onClose: () => void
}

/**
 * For a publish attempt whose outcome is unknown: the user checks the account
 * on X and records what they found. Nothing is retried until they do.
 */
export function ReviewDialog({ task, onClose }: ReviewDialogProps) {
  const toast = useToast()
  const [outcome, setOutcome] = useState<'posted' | 'not-posted'>('posted')
  const [url, setUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!task) return
    setOutcome('posted')
    setUrl('')
    setError(null)
  }, [task])

  const save = async () => {
    if (!task) return
    setSaving(true)
    setError(null)
    try {
      await relay.queue.resolveReview(outcome === 'posted' ? { taskId: task.id, outcome, url: url.trim() || null } : { taskId: task.id, outcome })
      toast(
        outcome === 'posted'
          ? { tone: 'success', title: 'Marked as published', description: url.trim() ? 'The link was saved to Post Links.' : undefined }
          : { tone: 'info', title: 'Marked as not posted', description: 'You can retry it from the queue when you’re ready.' }
      )
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={Boolean(task)}
      onClose={onClose}
      dismissible={!saving}
      title="Did this post go out?"
      description="X Auto submitted the post but could not confirm it, so it was not retried. Check the account on X and tell us what you found."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Not now
          </Button>
          <Button variant="primary" loading={saving} onClick={save}>
            {outcome === 'posted' ? 'Mark as published' : 'Mark as not posted'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {task?.draftPreview && <blockquote className="rounded-md border border-line bg-surface-1 px-3 py-2 text-sm text-fg-muted">{task.draftPreview}</blockquote>}
        {task?.accountHandle && (
          <Button size="sm" variant="secondary" icon={ExternalLink} className="self-start" onClick={() => void relay.shell.openExternal(`https://x.com/${task.accountHandle}`)}>
            Open @{task.accountHandle} on X
          </Button>
        )}
        <SegmentedControl<'posted' | 'not-posted'>
          value={outcome}
          onChange={setOutcome}
          options={[
            { value: 'posted', label: 'It was posted' },
            { value: 'not-posted', label: 'It wasn’t posted' }
          ]}
        />
        {outcome === 'posted' ? (
          <Field label="Link to the post" htmlFor="review-url" aside={<span className="text-2xs text-fg-faint">Optional</span>} hint="Paste it from X to keep it in Post Links.">
            <Input id="review-url" value={url} spellCheck={false} placeholder="https://x.com/username/status/…" onChange={(e) => setUrl(e.target.value)} />
          </Field>
        ) : (
          <p className="text-xs text-fg-subtle">The task is marked as failed. Nothing is posted until you choose Retry.</p>
        )}
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}
