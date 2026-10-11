import {
  CircleAlert,
  CirclePlus,
  History,
  Link2,
  Link2Off,
  MonitorPlay,
  PencilLine,
  Power,
  ShieldCheck,
  ToggleLeft,
  Trash2,
  X,
  type LucideIcon
} from 'lucide-react'
import type { Account, AccountEvent, AccountEventKind } from '@shared/types/accounts'
import { AccountAvatar } from '@/components/feature/AccountAvatar'
import { Button, IconButton, Panel, SkeletonRows, Spinner, StatusBadge, Switch, Tooltip } from '@/components/ui'
import { useAccountDetails } from '@/data/accounts'
import { cn } from '@/lib/cn'
import { formatDateTime, formatRelative } from '@/lib/format'
import { displayHandle, IDENTITY, LINK_STATE, linkState } from './accountMeta'
import { ProfileStateBadge } from './ProfileStateBadge'

interface AccountDetailsPanelProps {
  account: Account
  /** An open/close request for the linked profile is in flight. */
  pending: 'open' | 'close' | undefined
  canOperate: boolean
  busy: boolean
  onEdit: () => void
  onLink: () => void
  onUnlink: () => void
  onToggleEnabled: (enabled: boolean) => void
  onRemove: () => void
  onOpenProfile: () => void
  onCloseProfile: () => void
  onDismiss: () => void
}

const EVENT_ICON: Record<AccountEventKind, { icon: LucideIcon; tone: string }> = {
  created: { icon: CirclePlus, tone: 'text-fg-subtle' },
  updated: { icon: PencilLine, tone: 'text-fg-subtle' },
  identity: { icon: ShieldCheck, tone: 'text-info' },
  linked: { icon: Link2, tone: 'text-success' },
  unlinked: { icon: Link2Off, tone: 'text-fg-subtle' },
  enabled: { icon: ToggleLeft, tone: 'text-success' },
  disabled: { icon: ToggleLeft, tone: 'text-fg-subtle' },
  'profile-opened': { icon: MonitorPlay, tone: 'text-success' },
  'profile-closed': { icon: Power, tone: 'text-fg-subtle' },
  'profile-renamed': { icon: PencilLine, tone: 'text-info' },
  'profile-unavailable': { icon: CircleAlert, tone: 'text-warning' },
  'profile-restored': { icon: Link2, tone: 'text-success' },
  'operation-failed': { icon: CircleAlert, tone: 'text-danger' }
}

export function AccountDetailsPanel(props: AccountDetailsPanelProps) {
  const { account: a, pending } = props
  const details = useAccountDetails(a.id)
  const state = linkState(a)
  const identity = IDENTITY[a.identity]
  const handle = displayHandle(a)
  const p = a.profile

  const rows: [string, React.ReactNode][] = [
    ['Profile', p ? <span title={p.name}>{p.name}</span> : <span className="text-fg-subtle">Not linked</span>],
    ['Profile ID', p ? <span className="tabular font-mono text-xs">#{p.externalId}</span> : '—'],
    ['Profile status', p ? <ProfileStateBadge profile={p} /> : '—'],
    ['Last synchronised', p ? formatDateTime(p.lastSyncedAt) : '—'],
    ['Status checked', p?.statusCheckedAt ? formatRelative(p.statusCheckedAt) : '—'],
    ['Linked since', a.linkedAt ? formatDateTime(a.linkedAt) : '—'],
    ['Last activity', a.lastActiveAt ? formatRelative(a.lastActiveAt) : '—'],
    ['Record created', formatDateTime(a.createdAt)]
  ]

  return (
    <Panel
      padded={false}
      className="animate-fade-in"
      title={<span className="truncate">{a.label}</span>}
      meta={
        <StatusBadge tone={LINK_STATE[state].tone} dot>
          {LINK_STATE[state].label}
        </StatusBadge>
      }
      actions={
        <>
          <IconButton icon={PencilLine} label="Edit account" size="sm" onClick={props.onEdit} />
          <IconButton icon={X} label="Close details" size="sm" onClick={props.onDismiss} />
        </>
      }
    >
      <div className="flex items-start gap-3 border-b border-line px-4 py-3.5">
        <AccountAvatar name={a.label} handle={a.handle ?? a.id} size={36} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span data-selectable className={cn('truncate text-sm', handle ? 'font-medium text-fg' : 'text-fg-subtle')}>
            {handle ?? 'X username unknown'}
          </span>
          {a.identity === 'unknown' ? (
            <span className="text-2xs text-fg-faint">Add it with Edit if you know it. Profile names are never used as usernames.</span>
          ) : (
            <Tooltip content={identity.description}>
              <span className="w-fit">
                <StatusBadge tone={identity.tone} icon={a.identity === 'confirmed' ? ShieldCheck : undefined}>
                  {identity.label}
                </StatusBadge>
              </span>
            </Tooltip>
          )}
          {a.identity === 'confirmed' && a.identityConfirmedAt && (
            <span className="text-2xs text-fg-faint">Confirmed {formatRelative(a.identityConfirmedAt)} · not verified with X</span>
          )}
        </div>
      </div>

      <dl className="flex flex-col px-4 py-1.5">
        {rows.map(([label, value]) => (
          <div key={label} className="flex min-h-9 items-center justify-between gap-3 border-b border-line py-1.5 text-sm last:border-0">
            <dt className="shrink-0 text-fg-subtle">{label}</dt>
            <dd data-selectable className="min-w-0 truncate text-right text-fg">
              {value}
            </dd>
          </div>
        ))}
      </dl>

      {state === 'profile-unavailable' && (
        <p className="mx-4 mb-3 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning">
          IX Browser did not report this profile in the last sync. The link is kept in case it returns — sync again, or move the link.
        </p>
      )}

      <div className="flex items-start justify-between gap-4 border-t border-line px-4 py-3">
        <label htmlFor={`enabled-${a.id}`} className="flex flex-col gap-0.5">
          <span className="text-sm text-fg">Task assignment</span>
          <span className="text-xs text-fg-subtle">{a.enabled ? 'Can be chosen for future tasks.' : 'Excluded from future tasks.'} Local only — X is unaffected.</span>
        </label>
        <Switch id={`enabled-${a.id}`} checked={a.enabled} disabled={props.busy} onChange={props.onToggleEnabled} />
      </div>

      {a.notes && (
        <div className="border-t border-line px-4 py-3">
          <p className="pb-1.5 text-2xs font-medium uppercase tracking-[0.07em] text-fg-faint">Notes</p>
          <p data-selectable className="whitespace-pre-wrap break-words text-sm text-fg-muted">
            {a.notes}
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
        {p && p.availability === 'available' ? (
          pending ? (
            <span className="flex flex-1 items-center gap-2 text-sm text-fg-muted">
              <Spinner size={13} /> {pending === 'open' ? 'Opening profile…' : 'Closing profile…'}
            </span>
          ) : p.runState === 'running' ? (
            <Button icon={Power} disabled={!props.canOperate} onClick={props.onCloseProfile} className="flex-1">
              Close profile
            </Button>
          ) : (
            <Button variant="primary" icon={MonitorPlay} disabled={!props.canOperate} onClick={props.onOpenProfile} className="flex-1">
              Open profile
            </Button>
          )
        ) : (
          <Button variant={p ? 'secondary' : 'primary'} icon={Link2} onClick={props.onLink} className="flex-1">
            {p ? 'Move link' : 'Link a profile'}
          </Button>
        )}
        {p && p.availability === 'available' && (
          <IconButton icon={Link2} label="Change linked profile" onClick={props.onLink} disabled={Boolean(pending)} />
        )}
        {p && <IconButton icon={Link2Off} label="Unlink profile" onClick={props.onUnlink} disabled={Boolean(pending) || props.busy} />}
        <IconButton icon={Trash2} label="Remove account record" onClick={props.onRemove} disabled={props.busy} className="hover:text-danger" />
      </div>
      {p && !props.canOperate && p.availability === 'available' && (
        <p className="-mt-1 px-4 pb-3 text-2xs text-fg-faint">Opening and closing needs an active IX Browser connection.</p>
      )}

      <div className="border-t border-line">
        <p className="flex items-center gap-1.5 px-4 pb-1 pt-3 text-2xs font-medium uppercase tracking-[0.07em] text-fg-faint">
          <History size={11} /> Recent activity
        </p>
        {details.status === 'error' ? (
          <p className="px-4 pb-3 text-xs text-danger">Could not load activity.</p>
        ) : !details.data ? (
          <SkeletonRows rows={2} className="px-4 pb-3" />
        ) : (
          <ActivityList events={details.data.events} />
        )}
      </div>
    </Panel>
  )
}

function ActivityList({ events }: { events: AccountEvent[] }) {
  if (!events.length) return <p className="px-4 pb-3 text-xs text-fg-subtle">No activity yet.</p>
  return (
    <ol className="flex max-h-72 flex-col overflow-y-auto px-4 pb-2">
      {events.map((event) => {
        const { icon: Icon, tone } = EVENT_ICON[event.kind]
        return (
          <li key={event.id} className="flex gap-2.5 border-b border-line py-2 last:border-0">
            <Icon size={13} strokeWidth={1.9} className={cn('mt-0.5 shrink-0', tone)} aria-hidden />
            <span className="min-w-0 flex-1 break-words text-xs text-fg-muted">{event.message}</span>
            <time dateTime={event.at} title={formatDateTime(event.at)} className="tabular shrink-0 text-2xs text-fg-faint">
              {formatRelative(event.at)}
            </time>
          </li>
        )
      })}
    </ol>
  )
}
