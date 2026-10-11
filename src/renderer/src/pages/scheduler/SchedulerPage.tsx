import { CalendarClock, CalendarPlus, ExternalLink, FileText, Image as ImageIcon, PencilLine, RotateCw, SearchCheck, Send, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import type { Draft } from '@shared/types/domain'
import type { ScheduleEntry, ScheduleQuery } from '@shared/types/publishing'
import { Button, ConfirmDialog, EmptyState, Modal, PageHeader, Panel, SearchField, Select, SkeletonRows, StatusBadge, Tabs, useToast } from '@/components/ui'
import { ReviewDialog } from '@/components/feature/ReviewDialog'
import { ScheduleDialog, type ScheduleMode } from '@/components/feature/ScheduleDialog'
import { useAccounts } from '@/data/accounts'
import { useDrafts } from '@/data/drafts'
import { useNextSchedule, useScheduleCounts, useSchedules } from '@/data/publishing'
import { useQueryParam } from '@/hooks/useQueryParam'
import { errorMessage, relay } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { formatDateTime, formatRelative } from '@/lib/format'
import { SCHEDULE_STATUS } from '@/lib/status'
import { NAV_ITEMS } from '@/app/navigation'

type View = ScheduleQuery['view']
const VIEWS: View[] = ['upcoming', 'attention', 'history']

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
const timeOf = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const longDay = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' })

function dayHeading(d: Date): string {
  const today = new Date()
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
  if (dayKey(d) === dayKey(today)) return `Today · ${longDay.format(d)}`
  if (dayKey(d) === dayKey(tomorrow)) return `Tomorrow · ${longDay.format(d)}`
  return longDay.format(d)
}

export function SchedulerPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const [viewParam, setViewParam] = useQueryParam('view')
  const view: View = VIEWS.includes(viewParam as View) ? (viewParam as View) : 'upcoming'
  const [accountFilter, setAccountFilter] = useState<string>('all')
  const [day, setDay] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const accounts = useAccounts()
  const schedules = useSchedules({ view, ...(accountFilter !== 'all' ? { accountId: accountFilter } : {}) })
  const counts = useScheduleCounts()
  const next = useNextSchedule()
  const [dialog, setDialog] = useState<{ mode: ScheduleMode; entry: ScheduleEntry | null; draft: Draft | null } | null>(null)
  const [picking, setPicking] = useState(false)
  const [cancelling, setCancelling] = useState<ScheduleEntry | null>(null)
  const [reviewing, setReviewing] = useState<ScheduleEntry | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const entries = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (schedules.data ?? []).filter(
      (e) => (!day || dayKey(new Date(e.schedule.runAt)) === day) && (!q || `${e.draft?.preview ?? ''} ${e.account?.label ?? ''} ${e.account?.handle ?? ''}`.toLowerCase().includes(q))
    )
  }, [schedules.data, day, search])

  const groups = useMemo(() => {
    const map = new Map<string, { date: Date; items: ScheduleEntry[] }>()
    for (const e of entries) {
      const date = new Date(e.schedule.runAt)
      const key = dayKey(date)
      if (!map.has(key)) map.set(key, { date, items: [] })
      map.get(key)!.items.push(e)
    }
    return [...map.entries()]
  }, [entries])

  // The next seven days with how many posts each has (upcoming view only).
  const week = useMemo(() => {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    return Array.from({ length: 7 }, (_, i) => {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
      const key = dayKey(date)
      return { key, date, count: (schedules.data ?? []).filter((e) => dayKey(new Date(e.schedule.runAt)) === key).length }
    })
  }, [schedules.data])

  const run = async (id: string, action: () => Promise<unknown>, title: string) => {
    setBusy(id)
    try {
      await action()
      toast({ tone: 'success', title })
    } catch (error) {
      toast({ tone: 'danger', title: 'That didn’t work', description: errorMessage(error) })
    } finally {
      setBusy(null)
    }
  }

  const c = counts.data
  const n = next.data
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={NAV_ITEMS.scheduler.label}
        description="Posts planned per account. Axora Relay publishes them on time while it is running."
        actions={
          <Button variant="primary" icon={CalendarPlus} onClick={() => setPicking(true)}>
            Schedule a draft
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-line bg-surface-2 px-4 py-3 text-sm">
        <span className="flex items-center gap-2 text-fg-muted">
          <CalendarClock size={15} className="text-fg-subtle" />
          {n ? (
            <span>
              Next: <span className="text-fg">{formatDateTime(n.schedule.runAt)}</span> · {n.account?.label ?? 'account'} <span className="text-fg-subtle">({formatRelative(n.schedule.runAt)})</span>
            </span>
          ) : (
            'Nothing scheduled'
          )}
        </span>
        <span className="text-fg-subtle">{c ? `${c.upcoming} upcoming` : ''}</span>
        {c && c.attention > 0 && (
          <button type="button" className="text-warning underline-offset-2 hover:underline" onClick={() => setViewParam('attention')}>
            {c.attention} need{c.attention === 1 ? 's' : ''} attention
          </button>
        )}
      </div>

      <Panel padded={false}>
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 px-4 pt-1">
          <Tabs<View>
            aria-label="Schedule view"
            value={view}
            onChange={(v) => {
              setViewParam(v === 'upcoming' ? '' : v)
              setDay(null)
            }}
            className="border-b-0"
            items={[
              { value: 'upcoming', label: 'Upcoming', count: c?.upcoming },
              { value: 'attention', label: 'Needs attention', count: c?.attention },
              { value: 'history', label: 'History' }
            ]}
          />
          <div className="mb-2 flex items-center gap-2">
            <Select<string>
              size="sm"
              className="w-44"
              aria-label="Filter by account"
              value={accountFilter}
              onChange={setAccountFilter}
              options={[{ value: 'all', label: 'All accounts' }, ...(accounts.data ?? []).map((a) => ({ value: a.id, label: a.label }))]}
            />
            <SearchField value={search} onChange={setSearch} placeholder="Search posts" size="sm" className="w-48" />
          </div>
        </div>

        {view === 'upcoming' && (
          <div className="grid grid-cols-7 gap-1.5 border-t border-line px-4 py-3" role="group" aria-label="Next seven days">
            {week.map((d) => (
              <button
                key={d.key}
                type="button"
                aria-pressed={day === d.key}
                onClick={() => setDay((current) => (current === d.key ? null : d.key))}
                className={cn(
                  'flex flex-col items-center gap-0.5 rounded-md border px-1 py-2 text-xs transition-colors',
                  day === d.key ? 'border-accent bg-accent-soft text-fg' : 'border-line bg-surface-1 text-fg-muted hover:bg-surface-3'
                )}
              >
                <span className="text-2xs uppercase tracking-[0.06em] text-fg-faint">{weekday.format(d.date)}</span>
                <span className="text-sm font-medium tabular">{d.date.getDate()}</span>
                <span className={cn('tabular text-2xs', d.count ? 'text-accent-text' : 'text-fg-faint')}>{d.count ? `${d.count} post${d.count === 1 ? '' : 's'}` : '—'}</span>
              </button>
            ))}
          </div>
        )}

        <div className="border-t border-line">
          {schedules.status === 'loading' && !schedules.data ? (
            <SkeletonRows rows={4} className="p-4" />
          ) : groups.length === 0 ? (
            <EmptyState
              size="sm"
              icon={view === 'attention' ? SearchCheck : CalendarClock}
              title={view === 'attention' ? 'Nothing needs your attention' : view === 'history' ? 'No finished schedules yet' : day ? 'Nothing on this day' : 'Nothing scheduled'}
              description={view === 'upcoming' && !day ? 'Pick a draft and a time — Axora Relay posts it from the account’s IX Browser profile.' : undefined}
              actions={
                view === 'upcoming' && !day ? (
                  <Button size="sm" icon={CalendarPlus} onClick={() => setPicking(true)}>
                    Schedule a draft
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="flex flex-col">
              {groups.map(([key, group]) => (
                <section key={key} aria-label={dayHeading(group.date)}>
                  <h3 className="sticky top-0 z-[1] border-b border-line bg-surface-1/95 px-4 py-1.5 text-2xs font-medium uppercase tracking-[0.07em] text-fg-faint backdrop-blur">
                    {dayHeading(group.date)}
                  </h3>
                  <ul>
                    {group.items.map((e) => (
                      <ScheduleRow
                        key={e.schedule.id}
                        entry={e}
                        busy={busy === e.schedule.id}
                        onReschedule={() => setDialog({ mode: 'reschedule', entry: e, draft: null })}
                        onCancel={() => setCancelling(e)}
                        onPublishNow={() => run(e.schedule.id, () => relay.publishing.resolveMissed(e.schedule.id, { action: 'publish-now' }), 'Sent to the queue')}
                        onRetry={() => e.task && run(e.schedule.id, () => relay.queue.retry(e.task!.id), 'Retrying')}
                        onEditAgain={() => e.draft && run(e.schedule.id, () => relay.publishing.returnToDrafts(e.draft!.id), 'Back in your drafts')}
                        onReview={() => setReviewing(e)}
                        onOpenDraft={() => e.draft && navigate(`/posts?draft=${e.draft.id}`)}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </Panel>

      <DraftPicker
        open={picking}
        onClose={() => setPicking(false)}
        onPick={(draft) => {
          setPicking(false)
          setDialog({ mode: 'schedule', entry: null, draft })
        }}
      />
      <ScheduleDialog
        open={Boolean(dialog)}
        mode={dialog?.mode ?? 'schedule'}
        draftId={dialog?.entry?.schedule.draftId ?? dialog?.draft?.id ?? null}
        accountId={dialog?.entry?.schedule.accountId ?? dialog?.draft?.accountId ?? null}
        accounts={accounts.data ?? []}
        entry={dialog?.entry ?? null}
        onClose={() => setDialog(null)}
      />
      <ReviewDialog
        task={
          reviewing?.task
            ? { id: reviewing.task.id, accountHandle: reviewing.account?.handle ?? null, accountLabel: reviewing.account?.label ?? null, draftPreview: reviewing.draft?.preview ?? null, error: reviewing.task.error }
            : null
        }
        onClose={() => setReviewing(null)}
      />
      <ConfirmDialog
        open={Boolean(cancelling)}
        title="Cancel this schedule?"
        description="The post won’t go out. The draft goes back to your list so you can edit it."
        confirmLabel="Cancel schedule"
        cancelLabel="Keep it"
        tone="danger"
        onCancel={() => setCancelling(null)}
        onConfirm={() => {
          const e = cancelling
          setCancelling(null)
          if (e) void run(e.schedule.id, () => relay.publishing.unschedule(e.schedule.id), 'Schedule cancelled')
        }}
      />
    </div>
  )
}

interface RowProps {
  entry: ScheduleEntry
  busy: boolean
  onReschedule: () => void
  onCancel: () => void
  onPublishNow: () => void
  onRetry: () => void
  onEditAgain: () => void
  onReview: () => void
  onOpenDraft: () => void
}

function ScheduleRow({ entry, busy, ...on }: RowProps) {
  const { schedule, draft, account, task } = entry
  const meta = SCHEDULE_STATUS[schedule.status]
  const running = schedule.status === 'queued' && task?.status === 'running'
  const detail =
    schedule.status === 'missed'
      ? 'Its time passed while Axora Relay was not running.'
      : schedule.status === 'needs-review'
        ? 'It may have been posted — check X and confirm.'
        : schedule.status === 'failed'
          ? (task?.error ?? 'Publishing failed.')
          : schedule.status === 'queued' && task?.status === 'queued' && new Date(task.runAfter).getTime() > new Date(schedule.runAt).getTime() + 60_000
            ? `Waiting until ${timeOf.format(new Date(task.runAfter))} to keep posts from this account apart.`
            : null
  const url = task?.result?.url ?? null
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2 border-b border-line px-4 py-3 last:border-b-0">
      <span className="w-20 shrink-0 whitespace-nowrap pt-0.5 text-sm font-medium tabular text-fg">{timeOf.format(new Date(schedule.runAt))}</span>
      <span className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
        <span className="line-clamp-2 text-sm text-fg">{draft?.preview || <span className="text-fg-faint">(no text)</span>}</span>
        <span className="flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
          <StatusBadge tone={meta.tone} dot pulse={meta.pulse || running}>
            {running ? 'Publishing now' : meta.label}
          </StatusBadge>
          <span>{account ? `${account.label}${account.handle ? ` · @${account.handle}` : ''}` : 'Account removed'}</span>
          {draft && draft.mediaCount > 0 && (
            <span className="flex items-center gap-1">
              <ImageIcon size={12} /> {draft.mediaCount}
            </span>
          )}
        </span>
        {detail && <span className={cn('text-xs', schedule.status === 'failed' ? 'text-danger' : 'text-warning')}>{detail}</span>}
      </span>
      <span className="flex shrink-0 flex-wrap items-center gap-1">
        {schedule.status === 'missed' && (
          <Button size="sm" variant="secondary" icon={Send} loading={busy} onClick={on.onPublishNow}>
            Publish now
          </Button>
        )}
        {schedule.status === 'needs-review' && (
          <Button size="sm" variant="secondary" icon={SearchCheck} onClick={on.onReview}>
            Check and confirm
          </Button>
        )}
        {schedule.status === 'failed' && task?.status === 'failed' && (
          <Button size="sm" variant="secondary" icon={RotateCw} loading={busy} onClick={on.onRetry}>
            Retry
          </Button>
        )}
        {(schedule.status === 'pending' || schedule.status === 'missed') && (
          <Button size="sm" variant="ghost" icon={CalendarClock} disabled={busy} onClick={on.onReschedule}>
            Change time
          </Button>
        )}
        {schedule.status === 'failed' && (
          <Button size="sm" variant="ghost" icon={PencilLine} disabled={busy} onClick={on.onEditAgain}>
            Edit again
          </Button>
        )}
        {(schedule.status === 'pending' || schedule.status === 'missed' || (schedule.status === 'queued' && task?.status === 'queued')) && (
          <Button size="sm" variant="ghost" icon={X} disabled={busy} onClick={on.onCancel}>
            Cancel
          </Button>
        )}
        {url && (
          <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => void relay.shell.openExternal(url)}>
            View on X
          </Button>
        )}
        {draft && (
          <Button size="sm" variant="ghost" icon={FileText} onClick={on.onOpenDraft}>
            Draft
          </Button>
        )}
      </span>
    </li>
  )
}

/** Choose a draft to schedule (drafts and ready posts only). */
function DraftPicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (draft: Draft) => void }) {
  const drafts = useDrafts()
  const [query, setQuery] = useState('')
  const list = (drafts.data ?? [])
    .filter((d) => d.status === 'ready' || d.status === 'draft')
    .filter((d) => !query.trim() || d.body.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => (a.status === b.status ? b.updatedAt.localeCompare(a.updatedAt) : a.status === 'ready' ? -1 : 1))
  return (
    <Modal open={open} onClose={onClose} title="Schedule a draft" description="Ready posts are listed first." size="lg">
      <div className="flex flex-col gap-3">
        <SearchField value={query} onChange={setQuery} placeholder="Search drafts" size="sm" />
        {list.length === 0 ? (
          <EmptyState size="sm" icon={FileText} title="No drafts to schedule" description="Write a post in Posts & Drafts first." />
        ) : (
          <ul className="flex max-h-96 flex-col overflow-y-auto rounded-md border border-line">
            {list.map((d) => (
              <li key={d.id} className="border-b border-line last:border-b-0">
                <button type="button" className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-surface-3 focus-visible:bg-surface-3" onClick={() => onPick(d)}>
                  <span className="line-clamp-2 min-w-0 flex-1 text-sm text-fg">{d.body.trim() || <span className="text-fg-faint">(image only)</span>}</span>
                  <StatusBadge tone={d.status === 'ready' ? 'success' : 'neutral'}>{d.status === 'ready' ? 'Ready' : 'Draft'}</StatusBadge>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
