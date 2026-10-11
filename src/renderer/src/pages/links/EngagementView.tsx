import { Check, ClipboardCopy, ExternalLink, MonitorPlay, Pencil, RotateCcw, ShieldCheck, SkipForward, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { Account } from '@shared/types/accounts'
import type { EngagementStatus, EngagementTaskView } from '@shared/types/links'
import { Button, ConfirmDialog, EmptyState, IconButton, Notice, Panel, Select, SkeletonRows, StatusBadge, Tabs, useToast } from '@/components/ui'
import { useEngagement, useEngagementCounts } from '@/data/links'
import { errorMessage, relay } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { formatDateTime, formatRelative } from '@/lib/format'
import { EngagementDialog } from './EngagementDialog'
import { ENGAGEMENT_KIND } from './engagementMeta'

type Filter = EngagementStatus | 'all'

function groupOf(t: EngagementTaskView): string {
  if (t.status !== 'open') return 'Finished'
  if (!t.dueAt) return 'No due date'
  const due = new Date(t.dueAt)
  const now = new Date()
  if (due.getTime() < now.getTime()) return 'Overdue'
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  return due < endOfToday ? 'Today' : 'Upcoming'
}
const GROUP_ORDER = ['Overdue', 'Today', 'Upcoming', 'No due date', 'Finished']

export function EngagementView({ accounts }: { accounts: Account[] }) {
  const toast = useToast()
  const [filter, setFilter] = useState<Filter>('open')
  const [account, setAccount] = useState('all')
  const tasks = useEngagement({ status: filter, ...(account !== 'all' ? { accountId: account } : {}) })
  const counts = useEngagementCounts()
  const [editing, setEditing] = useState<EngagementTaskView | null>(null)
  const [deleting, setDeleting] = useState<EngagementTaskView | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const groups = useMemo(() => {
    const map = new Map<string, EngagementTaskView[]>()
    for (const t of tasks.data ?? []) {
      const g = groupOf(t)
      if (!map.has(g)) map.set(g, [])
      map.get(g)!.push(t)
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => [g, map.get(g)!] as const)
  }, [tasks.data])

  const act = async (id: string, action: () => Promise<unknown>, title?: string) => {
    setBusy(id)
    try {
      await action()
      if (title) toast({ tone: 'success', title })
    } catch (error) {
      toast({ tone: 'danger', title: 'That didn’t work', description: errorMessage(error), duration: 8000 })
    } finally {
      setBusy(null)
    }
  }

  const openInProfile = (t: EngagementTaskView) =>
    act(t.id, async () => {
      const r = await relay.engagement.openInProfile(t.id)
      toast(
        r.signedOut
          ? { tone: 'warning', title: 'The profile is signed out of X', description: 'Sign in to X in that profile first.' }
          : { tone: 'success', title: 'Opened in the profile', description: `Do it in ${t.accountLabel ?? 'the account'}’s window, then mark the task done.` }
      )
    })

  const copyReply = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast({ tone: 'success', title: 'Text copied', description: 'Paste it into the reply yourself.' })
    } catch {
      toast({ tone: 'danger', title: 'Could not copy the text' })
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Notice icon={ShieldCheck} title="You do the engaging">
        Axora Relay never likes, reposts, quotes, replies or follows on its own. A task opens the post in the account’s own profile; you act there and mark it done. Liking or
        reposting your own posts from your other accounts, or coordinating several accounts on the same post, isn’t allowed by X’s rules — so those tasks can’t be planned.
      </Notice>
      <Panel padded={false}>
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 px-4 pt-1">
          <Tabs<Filter>
            aria-label="Filter tasks"
            value={filter}
            onChange={setFilter}
            className="border-b-0"
            items={[
              { value: 'open', label: 'Open', count: counts.data?.open },
              { value: 'done', label: 'Done' },
              { value: 'skipped', label: 'Skipped' },
              { value: 'all', label: 'All' }
            ]}
          />
          <Select<string>
            size="sm"
            className="mb-2 w-44"
            aria-label="Filter by account"
            value={account}
            onChange={setAccount}
            options={[{ value: 'all', label: 'All accounts' }, ...accounts.map((a) => ({ value: a.id, label: a.label }))]}
          />
        </div>
        <div className="border-t border-line">
          {tasks.status === 'loading' && !tasks.data ? (
            <SkeletonRows rows={3} className="p-4" />
          ) : groups.length === 0 ? (
            <EmptyState size="sm" icon={Check} title={filter === 'open' ? 'Nothing to do' : 'No tasks here'} description={filter === 'open' ? 'Plan tasks from the Links tab: select posts and choose “Plan a task”.' : undefined} />
          ) : (
            groups.map(([group, items]) => (
              <section key={group} aria-label={group}>
                <h3 className={cn('border-b border-line px-4 py-1.5 text-2xs font-medium uppercase tracking-[0.07em]', group === 'Overdue' ? 'text-warning' : 'text-fg-faint')}>
                  {group} · {items.length}
                </h3>
                <ul>
                  {items.map((t) => {
                    const Icon = ENGAGEMENT_KIND[t.kind].icon
                    return (
                      <li key={t.id} className="flex flex-wrap items-start gap-x-3 gap-y-2 border-b border-line px-4 py-3 last:border-b-0">
                        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-surface-3 text-fg-muted">
                          <Icon size={14} />
                        </span>
                        <span className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
                          <span className="flex flex-wrap items-center gap-2 text-sm text-fg">
                            {ENGAGEMENT_KIND[t.kind].label}
                            <span className="text-xs text-fg-subtle">{t.accountLabel ? `as ${t.accountLabel}${t.accountHandle ? ` (@${t.accountHandle})` : ''}` : 'no account'}</span>
                            {t.status !== 'open' && <StatusBadge tone={t.status === 'done' ? 'success' : 'neutral'}>{t.status === 'done' ? 'Done' : 'Skipped'}</StatusBadge>}
                          </span>
                          <span className="truncate text-xs text-fg-muted">{t.linkPreview || t.linkUrl.replace('https://', '')}</span>
                          {t.dueAt && t.status === 'open' && <span className={cn('text-2xs', groupOf(t) === 'Overdue' ? 'text-warning' : 'text-fg-subtle')}>Due {formatDateTime(t.dueAt)} ({formatRelative(t.dueAt)})</span>}
                          {t.note && <span className="text-xs text-fg-subtle">{t.note}</span>}
                          {t.replyText && <span className="line-clamp-2 rounded-sm border-l-2 border-line-strong pl-2 text-xs italic text-fg-muted">{t.replyText}</span>}
                        </span>
                        <span className="flex shrink-0 flex-wrap items-center gap-1">
                          {t.status === 'open' ? (
                            <>
                              {t.accountId && (
                                <Button size="sm" variant="secondary" icon={MonitorPlay} loading={busy === t.id} onClick={() => void openInProfile(t)}>
                                  Open in profile
                                </Button>
                              )}
                              {t.replyText && <IconButton icon={ClipboardCopy} label="Copy reply text" size="sm" onClick={() => void copyReply(t.replyText)} />}
                              <IconButton icon={ExternalLink} label="Open on X in your browser" size="sm" onClick={() => void relay.shell.openExternal(t.linkUrl)} />
                              <Button size="sm" variant="ghost" icon={Check} disabled={busy === t.id} onClick={() => void act(t.id, () => relay.engagement.setStatus([t.id], 'done'), 'Marked done')}>
                                Done
                              </Button>
                              <IconButton icon={SkipForward} label="Skip" size="sm" onClick={() => void act(t.id, () => relay.engagement.setStatus([t.id], 'skipped'))} />
                              <IconButton icon={Pencil} label="Edit task" size="sm" onClick={() => setEditing(t)} />
                            </>
                          ) : (
                            <IconButton icon={RotateCcw} label="Reopen" size="sm" onClick={() => void act(t.id, () => relay.engagement.setStatus([t.id], 'open'), 'Reopened')} />
                          )}
                          <IconButton icon={Trash2} label="Delete task" size="sm" onClick={() => setDeleting(t)} />
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ))
          )}
        </div>
      </Panel>
      <EngagementDialog open={Boolean(editing)} task={editing} accounts={accounts} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={Boolean(deleting)}
        title="Delete this task?"
        description="Only the reminder is deleted."
        confirmLabel="Delete"
        tone="danger"
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const t = deleting
          setDeleting(null)
          if (t) void act(t.id, () => relay.engagement.remove([t.id]), 'Task deleted')
        }}
      />
    </div>
  )
}
