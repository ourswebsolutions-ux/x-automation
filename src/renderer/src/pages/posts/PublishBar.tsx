import { CalendarClock, ExternalLink, ListChecks, PencilLine, RotateCw, Send, Workflow, X } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import type { Account } from '@shared/types/accounts'
import type { Draft } from '@shared/types/domain'
import { Button, ConfirmDialog, Spinner, StatusBadge, Tooltip, useToast } from '@/components/ui'
import { PublishDialog } from '@/components/feature/PublishDialog'
import { ScheduleDialog, type ScheduleMode } from '@/components/feature/ScheduleDialog'
import { useDraftSchedule } from '@/data/publishing'
import { errorMessage, relay } from '@/lib/bridge'
import { formatDateTime } from '@/lib/format'
import { SCHEDULE_STATUS } from '@/lib/status'

interface PublishActionsProps {
  draft: Draft
  dirty: boolean
  /** False once the post is scheduled or published: the buttons hide, an open dialog stays. */
  editable?: boolean
  accountId: string | null
  accounts: Account[]
}

/** "Publish now" (all or selected accounts) and "Use in a campaign" for a saved, editable post. */
export function PublishActions({ draft, dirty, editable = true, accountId, accounts }: PublishActionsProps) {
  const navigate = useNavigate()
  const [publishing, setPublishing] = useState(false)
  const blocked = dirty ? 'Save your changes first' : null
  // One stable tree: the buttons come and go, the dialog keeps its place (and its progress).
  return (
    <>
      {editable && (
        <>
          <Tooltip content={blocked ?? 'Keep this post and choose it in a campaign'}>
            <span>
              <Button size="sm" variant="secondary" icon={Workflow} disabled={Boolean(blocked)} onClick={() => navigate(`/campaigns?draft=${draft.id}`)}>
                Use in a campaign
              </Button>
            </span>
          </Tooltip>
          <Tooltip content={blocked ?? ''} disabled={!blocked}>
            <span>
              <Button size="sm" variant="primary" icon={Send} disabled={Boolean(blocked)} onClick={() => setPublishing(true)}>
                Publish now…
              </Button>
            </span>
          </Tooltip>
        </>
      )}
      <PublishDialog open={publishing} draftId={draft.id} defaultAccountId={accountId} accounts={accounts} onClose={() => setPublishing(false)} />
    </>
  )
}

/** Where a scheduled, failed or published draft stands, with what can be done next. */
export function PublishStatus({ draft, accounts }: { draft: Draft; accounts: Account[] }) {
  const toast = useToast()
  const navigate = useNavigate()
  const { data: entry, status } = useDraftSchedule(draft.id)
  const [mode, setMode] = useState<ScheduleMode | null>(null)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [busy, setBusy] = useState(false)

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true)
    try {
      await action()
      toast({ tone: 'success', title: success })
    } catch (error) {
      toast({ tone: 'danger', title: 'That didn’t work', description: errorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  if (!entry) {
    return (
      <div className="flex items-center gap-2 border-b border-line bg-surface-1/60 px-4 py-2 text-xs text-fg-subtle">
        {status === 'loading' ? <Spinner size={12} /> : `This post is ${draft.status}.`}
      </div>
    )
  }
  const { schedule, task, account } = entry
  const meta = SCHEDULE_STATUS[schedule.status]
  const who = account ? (account.handle ? `@${account.handle}` : account.label) : 'a removed account'
  const url = task?.result?.url ?? null

  let line: string
  switch (schedule.status) {
    case 'pending':
      line = `Goes out ${formatDateTime(schedule.runAt)} from ${who}.`
      break
    case 'queued':
      line = task?.status === 'running' ? `Publishing from ${who} now…` : `Waiting in the queue to post from ${who}.`
      break
    case 'missed':
      line = `Its time (${formatDateTime(schedule.runAt)}) passed while X Auto was not running.`
      break
    case 'needs-review':
      line = `It may have been posted from ${who}. Check X, then confirm in the task queue.`
      break
    case 'failed':
      line = task?.error ?? 'Publishing failed.'
      break
    case 'completed':
      line = `Published from ${who}${task?.result?.verifiedBy === 'user' ? ' (confirmed by you)' : ''}.`
      break
    default:
      line = `This post is ${draft.status}.`
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface-1/60 px-4 py-2.5">
      <StatusBadge tone={meta.tone} dot pulse={meta.pulse}>
        {meta.label}
      </StatusBadge>
      <span className="min-w-0 flex-1 text-xs text-fg-muted">{line}</span>
      <span className="flex flex-wrap items-center gap-1.5">
        {(schedule.status === 'pending' || schedule.status === 'missed') && (
          <Button size="sm" variant="ghost" icon={CalendarClock} disabled={busy} onClick={() => setMode('reschedule')}>
            Change time
          </Button>
        )}
        {schedule.status === 'missed' && (
          <Button size="sm" variant="secondary" icon={Send} loading={busy} onClick={() => run(() => relay.publishing.resolveMissed(schedule.id, { action: 'publish-now' }), 'Sent to the queue')}>
            Publish now
          </Button>
        )}
        {(schedule.status === 'pending' || schedule.status === 'missed' || (schedule.status === 'queued' && task?.status === 'queued')) && (
          <Button size="sm" variant="ghost" icon={X} disabled={busy} onClick={() => setConfirmCancel(true)}>
            Cancel schedule
          </Button>
        )}
        {schedule.status === 'needs-review' && (
          <Button size="sm" variant="secondary" icon={ListChecks} onClick={() => navigate('/campaigns?queue=attention')}>
            Review in the queue
          </Button>
        )}
        {schedule.status === 'failed' && task?.status === 'failed' && (
          <Button size="sm" variant="secondary" icon={RotateCw} loading={busy} onClick={() => run(() => relay.queue.retry(task.id), 'Retrying')}>
            Retry
          </Button>
        )}
        {(schedule.status === 'failed' || draft.status === 'failed') && (
          <Button size="sm" variant="ghost" icon={PencilLine} disabled={busy} onClick={() => run(() => relay.publishing.returnToDrafts(draft.id), 'Back in your drafts')}>
            Edit again
          </Button>
        )}
        {url && (
          <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => void relay.shell.openExternal(url)}>
            View on X
          </Button>
        )}
      </span>
      <ScheduleDialog open={mode !== null} mode={mode ?? 'reschedule'} draftId={draft.id} accountId={schedule.accountId} accounts={accounts} entry={entry} onClose={() => setMode(null)} />
      <ConfirmDialog
        open={confirmCancel}
        title="Cancel this schedule?"
        description="The post won’t go out. The draft goes back to your list so you can edit it."
        confirmLabel="Cancel schedule"
        cancelLabel="Keep it"
        tone="danger"
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() => {
          setConfirmCancel(false)
          void run(() => relay.publishing.unschedule(schedule.id), 'Schedule cancelled')
        }}
      />
    </div>
  )
}
