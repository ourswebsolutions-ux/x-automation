import {
  CirclePlus,
  Globe,
  Link2,
  Link2Off,
  MonitorPlay,
  Plus,
  Power,
  RefreshCw,
  RotateCw,
  Settings2,
  ToggleLeft,
  ToggleRight,
  Trash2,
  UserPlus,
  UsersRound,
  X
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import type { Account, BulkResult } from '@shared/types/accounts'
import type { BrowserProfile } from '@shared/types/ixbrowser'
import {
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  IconButton,
  LiveBadge,
  Panel,
  SearchField,
  Select,
  SkeletonRows,
  Spinner,
  StatusBadge,
  Tabs,
  Tooltip,
  useToast,
  type Column
} from '@/components/ui'
import { AccountAvatar } from '@/components/feature/AccountAvatar'
import { useAccounts } from '@/data/accounts'
import { useBrowserProfiles, useIxOverview } from '@/data/ixbrowser'
import { useQueryParam } from '@/hooks/useQueryParam'
import { errorMessage, relay } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { formatNumber, formatRelative, pluralize } from '@/lib/format'
import { settingsPath } from '@/app/navigation'
import { AccountDetailsPanel } from './AccountDetailsPanel'
import { AccountDialog } from './AccountDialog'
import { displayHandle, IDENTITY, LINK_STATE, linkState } from './accountMeta'
import { LinkProfileDialog } from './LinkProfileDialog'
import { ProfileStateBadge } from './ProfileStateBadge'

/** One table row: an account record, or a synchronised profile no account uses yet. */
type Row = { kind: 'account'; key: string; account: Account } | { kind: 'profile'; key: string; profile: BrowserProfile }
type Filter = 'all' | 'linked' | 'unlinked' | 'available' | 'unavailable'

const availabilityOf = (row: Row) => (row.kind === 'profile' ? row.profile.availability : (row.account.profile?.availability ?? null))

const matches = (row: Row, filter: Filter) => {
  switch (filter) {
    case 'all':
      return true
    case 'linked':
      return row.kind === 'account' && row.account.profile !== null
    case 'unlinked':
      return row.kind === 'profile' || row.account.profile === null
    case 'available':
      return availabilityOf(row) === 'available'
    case 'unavailable':
      return availabilityOf(row) === 'unavailable'
  }
}

const searchText = (row: Row) =>
  row.kind === 'account'
    ? `${row.account.label} ${row.account.handle ?? ''} @${row.account.handle ?? ''} ${row.account.profile ? `${row.account.profile.externalId} #${row.account.profile.externalId} ${row.account.profile.name}` : ''}`
    : `${row.profile.name} ${row.profile.externalId} #${row.profile.externalId}`

/** Status sort order: problems first, then linked, then the rest. */
const statusRank = (row: Row) => {
  if (row.kind === 'profile') return 3
  const state = linkState(row.account)
  return state === 'profile-unavailable' ? 0 : state === 'linked' ? (row.account.enabled ? 1 : 2) : 4
}

type Confirm =
  | { action: 'remove'; ids: string[]; labels: string[] }
  | { action: 'unlink'; ids: string[]; labels: string[] }
  | { action: 'close'; account: Account }

const summarize = (result: BulkResult, verb: string) => {
  const reasons = [...new Set(result.skipped.map((s) => s.reason))]
  return {
    title: `${pluralize(result.changed, 'account')} ${verb}`,
    description: result.skipped.length ? `${result.skipped.length} skipped — ${reasons.slice(0, 2).join('; ')}` : undefined
  }
}

export function AccountsView() {
  const navigate = useNavigate()
  const toast = useToast()
  const accounts = useAccounts()
  const profiles = useBrowserProfiles()
  const overview = useIxOverview()
  const o = overview.data
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useQueryParam('q')
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dialog, setDialog] = useState<{ account: Account | null; profileId: string | null } | null>(null)
  const [linking, setLinking] = useState<Account | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const accountList = accounts.data ?? []
  const profileList = profiles.data ?? []

  const rows = useMemo<Row[]>(() => {
    const linked = new Set(accountList.flatMap((a) => (a.profile ? [a.profile.id] : [])))
    return [
      ...accountList.map((account) => ({ kind: 'account' as const, key: `a:${account.id}`, account })),
      ...profileList.filter((p) => !linked.has(p.id)).map((profile) => ({ kind: 'profile' as const, key: `p:${profile.id}`, profile }))
    ]
  }, [accountList, profileList])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((row) => matches(row, filter) && (!q || searchText(row).toLowerCase().includes(q)))
  }, [rows, filter, query])

  // Keep the selection and the details panel pointing at rows that still exist.
  useEffect(() => {
    const keys = new Set(rows.map((r) => r.key))
    setSelected((current) => {
      const next = new Set([...current].filter((key) => keys.has(key)))
      return next.size === current.size ? current : next
    })
    // A profile row becomes an account row once an account is created for it.
    // Other missing keys are left alone: a just-created account appears after the next reload.
    if (activeKey?.startsWith('p:') && !keys.has(activeKey)) {
      const owner = accountList.find((a) => a.profile?.id === activeKey.slice(2))
      if (owner) setActiveKey(`a:${owner.id}`)
    }
  }, [rows, activeKey, accountList])

  const active = rows.find((r) => r.key === activeKey) ?? null
  const selectedRows = rows.filter((r) => selected.has(r.key))
  const selectedAccounts = selectedRows.flatMap((r) => (r.kind === 'account' ? [r.account] : []))
  const selectedProfiles = selectedRows.flatMap((r) => (r.kind === 'profile' ? [r.profile] : []))
  const pending = o?.pending ?? {}
  const canOperate = Boolean(o?.configured)

  const counts = {
    profiles: o?.counts.total ?? profileList.length,
    available: o?.counts.available ?? 0,
    unavailable: o?.counts.unavailable ?? 0,
    linked: accountList.filter((a) => a.profile).length,
    unlinkedProfiles: rows.filter((r) => r.kind === 'profile' && r.profile.availability === 'available').length,
    accounts: accountList.length,
    disabled: accountList.filter((a) => !a.enabled).length
  }

  const run = async <T,>(work: () => Promise<T>, done: (value: T) => void, failure: string) => {
    setBusy(true)
    try {
      done(await work())
    } catch (error) {
      toast({ tone: 'danger', title: failure, description: errorMessage(error), duration: 8000 })
    } finally {
      setBusy(false)
    }
  }

  const setEnabled = (ids: string[], enabled: boolean) =>
    run(
      () => relay.accounts.setEnabled(ids, enabled),
      (result) => {
        const { title, description } = summarize(result, enabled ? 'enabled for task assignment' : 'disabled for task assignment')
        toast({ tone: result.changed ? 'success' : 'info', title, description: description ?? 'Local setting only — nothing changed on X.' })
      },
      'Could not update accounts'
    )

  const createFromProfiles = (ids: string[]) =>
    run(
      () => relay.accounts.createFromProfiles(ids),
      (result) => {
        const { title, description } = summarize(result, 'created')
        toast({ tone: result.changed ? 'success' : 'info', title, description: description ?? 'Each is labelled with its profile name. X usernames stay unknown until you add them.' })
        setSelected(new Set())
        if (result.accounts.length === 1) setActiveKey(`a:${result.accounts[0]!.id}`)
      },
      'Could not create accounts'
    )

  const operate = async (account: Account, operation: 'open' | 'close') => {
    try {
      const result = operation === 'open' ? await relay.accounts.openProfile(account.id) : await relay.accounts.closeProfile(account.id)
      toast({
        tone: result.confirmed ? 'success' : 'warning',
        title: `${operation === 'open' ? 'Opened' : 'Closed'} profile for “${account.label}”`,
        description: result.confirmed ? undefined : 'IX Browser accepted the request, but its status list did not confirm the change yet.'
      })
    } catch (error) {
      toast({ tone: 'danger', title: `Could not ${operation} the profile`, description: errorMessage(error), duration: 8000 })
    }
  }

  const refreshStatus = async () => {
    setRefreshing(true)
    try {
      await relay.ixbrowser.refreshStatus()
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not refresh status', description: errorMessage(error) })
    } finally {
      setRefreshing(false)
    }
  }

  const sync = async () => {
    try {
      const result = await relay.ixbrowser.sync()
      toast({ tone: 'success', title: 'Profiles synchronised', description: `${result.discovered} found · ${result.added} new · ${result.unavailable} unavailable` })
    } catch (error) {
      const message = errorMessage(error)
      toast(message.startsWith('Cancelled') ? { tone: 'info', title: 'Sync cancelled' } : { tone: 'danger', title: 'Sync failed', description: message, duration: 9000 })
    }
  }

  const onConfirm = () => {
    const c = confirm
    if (!c) return
    if (c.action === 'close') {
      setConfirm(null)
      void operate(c.account, 'close')
      return
    }
    void run(
      () => (c.action === 'remove' ? relay.accounts.remove(c.ids) : relay.accounts.unlink(c.ids)),
      (result) => {
        const { title, description } = summarize(result, c.action === 'remove' ? 'removed' : 'unlinked')
        toast({
          tone: result.changed ? 'success' : 'warning',
          title,
          description: description ?? 'Browser profiles in IX Browser were not changed.'
        })
        setConfirm(null)
        setSelected(new Set())
      },
      c.action === 'remove' ? 'Could not remove' : 'Could not unlink'
    )
  }

  if (accounts.status === 'error' && !accounts.data) return <ErrorState title="Accounts could not be loaded" error={accounts.error} onRetry={accounts.reload} />
  if (!accounts.data || !o) return <SkeletonRows rows={5} />

  const nothingYet = accountList.length === 0 && profileList.length === 0

  const columns: Column<Row>[] = [
    {
      id: 'account',
      header: 'Account',
      width: '29%',
      sortValue: (r) => (r.kind === 'account' ? r.account.label : `￿${r.profile.name}`).toLowerCase(),
      cell: (r) =>
        r.kind === 'account' ? (
          <div className="flex min-w-0 items-center gap-2.5">
            <AccountAvatar name={r.account.label} handle={r.account.handle ?? r.account.id} />
            <div className="flex min-w-0 flex-col">
              <span className={cn('truncate', r.account.enabled ? 'text-fg' : 'text-fg-subtle')}>{r.account.label}</span>
              <span className="flex min-w-0 items-center gap-1.5 text-xs">
                {r.account.handle ? (
                  <>
                    <span className="truncate text-fg-subtle">{displayHandle(r.account)}</span>
                    {r.account.identity === 'unverified' && <span className="shrink-0 text-2xs text-warning">not verified</span>}
                  </>
                ) : (
                  <span className="truncate text-fg-faint">{IDENTITY.unknown.label}</span>
                )}
                {!r.account.enabled && (
                  <span title="Excluded from task assignment (local setting)" className="shrink-0 text-2xs text-fg-faint">
                    · disabled
                  </span>
                )}
              </span>
            </div>
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-2.5">
            <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full border border-dashed border-line-heavy text-fg-faint">
              <Globe size={12} />
            </span>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-fg-subtle">No account</span>
              <span className="truncate text-xs text-fg-faint">Unlinked profile</span>
            </div>
          </div>
        )
    },
    {
      id: 'profile',
      header: 'Browser profile',
      width: '23%',
      sortValue: (r) => (r.kind === 'account' ? (r.account.profile?.name ?? '￿') : r.profile.name).toLowerCase(),
      cell: (r) => {
        const p = r.kind === 'account' ? r.account.profile : r.profile
        if (!p) return <span className="text-fg-faint">Not linked</span>
        return (
          <span className="flex min-w-0 flex-col">
            <span className={cn('truncate', p.availability === 'unavailable' ? 'text-fg-subtle line-through decoration-fg-faint' : 'text-fg-muted')}>{p.name}</span>
            <span className="tabular font-mono text-2xs text-fg-faint">#{p.externalId}</span>
          </span>
        )
      }
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: statusRank,
      cell: (r) => {
        if (r.kind === 'profile') return <ProfileStateBadge profile={r.profile} />
        const state = linkState(r.account)
        return (
          <span className="flex flex-wrap items-center gap-1.5">
            {state === 'linked' && r.account.profile ? (
              <ProfileStateBadge profile={r.account.profile} />
            ) : (
              <StatusBadge tone={LINK_STATE[state].tone} variant={state === 'not-linked' ? 'outline' : 'soft'} dot={state !== 'not-linked'}>
                {LINK_STATE[state].label}
              </StatusBadge>
            )}
          </span>
        )
      }
    },
    {
      id: 'synced',
      header: 'Last sync',
      width: '96px',
      sortValue: (r) => {
        const at = r.kind === 'account' ? r.account.profile?.lastSyncedAt : r.profile.lastSyncedAt
        return at ? -new Date(at).getTime() : Number.MAX_SAFE_INTEGER
      },
      cell: (r) => {
        const at = r.kind === 'account' ? r.account.profile?.lastSyncedAt : r.profile.lastSyncedAt
        return <span className="tabular text-xs text-fg-subtle">{at ? formatRelative(at) : '—'}</span>
      }
    },
    {
      id: 'actions',
      header: '',
      width: '120px',
      align: 'right',
      cell: (r) =>
        r.kind === 'profile' ? (
          r.profile.availability === 'available' && (
            <Button
              size="sm"
              variant="ghost"
              icon={UserPlus}
              onClick={(event) => {
                event.stopPropagation()
                setDialog({ account: null, profileId: r.profile.id })
              }}
            >
              Add account
            </Button>
          )
        ) : (
          <RowProfileAction
            account={r.account}
            pending={r.account.profile ? pending[r.account.profile.externalId] : undefined}
            canOperate={canOperate}
            onOpen={() => operate(r.account, 'open')}
            onClose={() => setConfirm({ action: 'close', account: r.account })}
            onLink={() => setLinking(r.account)}
          />
        )
    }
  ]

  return (
    <div className="flex flex-col gap-4">
      <SummaryStrip
        counts={counts}
        lastSync={o.lastSync?.finishedAt ?? null}
        lastSyncFailed={o.lastSync?.status === 'failed'}
        syncing={o.syncing}
        configured={o.configured}
        refreshing={refreshing}
        onRefresh={refreshStatus}
        onSync={sync}
        onSetup={() => navigate(settingsPath('ixbrowser'))}
      />

      {nothingYet ? (
        <Panel>
          <EmptyState
            icon={UsersRound}
            title="No accounts or profiles yet"
            description={
              o.configured
                ? 'Sync your IX Browser profiles, then link each one to the X account signed in to it. You can also create an account record first and link it later.'
                : 'Connect IX Browser to see your profiles, or create an account record now and link it once profiles are synchronised.'
            }
            actions={
              <>
                {o.configured ? (
                  <Button variant="primary" icon={RefreshCw} onClick={sync} disabled={o.syncing}>
                    Sync profiles
                  </Button>
                ) : (
                  <Button variant="primary" icon={Settings2} onClick={() => navigate(settingsPath('ixbrowser'))}>
                    Set up IX Browser
                  </Button>
                )}
                <Button icon={Plus} onClick={() => setDialog({ account: null, profileId: null })}>
                  New account
                </Button>
              </>
            }
          />
        </Panel>
      ) : (
        <div className="grid grid-cols-1 gap-4 @5xl:grid-cols-[minmax(0,1fr)_360px]">
          <Panel
            padded={false}
            title="Accounts & profiles"
            meta={<LiveBadge />}
            actions={
              <Button size="sm" variant="primary" icon={Plus} onClick={() => setDialog({ account: null, profileId: null })}>
                New account
              </Button>
            }
          >
            <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-line px-4 pt-1">
              <Tabs<Filter>
                aria-label="Filter records"
                value={filter}
                onChange={setFilter}
                className="border-b-0"
                items={[
                  { value: 'all', label: 'All', count: rows.length },
                  { value: 'linked', label: 'Linked', count: rows.filter((r) => matches(r, 'linked')).length },
                  { value: 'unlinked', label: 'Unlinked', count: rows.filter((r) => matches(r, 'unlinked')).length },
                  { value: 'available', label: 'Available', count: rows.filter((r) => matches(r, 'available')).length },
                  { value: 'unavailable', label: 'Unavailable', count: rows.filter((r) => matches(r, 'unavailable')).length }
                ]}
              />
              <div className="pb-2">
                <SearchField value={query} onChange={setQuery} placeholder="Label, username or profile ID" size="sm" className="w-60" aria-label="Search accounts" />
              </div>
            </div>

            <BulkBar
              accounts={selectedAccounts}
              profiles={selectedProfiles}
              busy={busy}
              onEnable={() => setEnabled(selectedAccounts.map((a) => a.id), true)}
              onDisable={() => setEnabled(selectedAccounts.map((a) => a.id), false)}
              onUnlink={() => {
                const linked = selectedAccounts.filter((a) => a.profile)
                setConfirm({ action: 'unlink', ids: linked.map((a) => a.id), labels: linked.map((a) => a.label) })
              }}
              onRemove={() => setConfirm({ action: 'remove', ids: selectedAccounts.map((a) => a.id), labels: selectedAccounts.map((a) => a.label) })}
              onCreate={() => createFromProfiles(selectedProfiles.filter((p) => p.availability === 'available').map((p) => p.id))}
              onClear={() => setSelected(new Set())}
            />

            {profiles.status === 'error' && (
              <p className="border-b border-line px-4 py-2 text-xs text-danger">Browser profiles could not be loaded: {errorMessage(profiles.error)}</p>
            )}
            <DataTable
              aria-label="Accounts and browser profiles"
              rows={visible}
              columns={columns}
              rowKey={(r) => r.key}
              onRowClick={(r) => setActiveKey((current) => (current === r.key ? null : r.key))}
              activeKey={activeKey}
              initialSort={{ id: 'account', direction: 'asc' }}
              pageSize={100}
              selection={{
                selected,
                onChange: setSelected,
                rowLabel: (r) => (r.kind === 'account' ? r.account.label : `profile ${r.profile.name}`)
              }}
              empty={
                <EmptyState
                  size="sm"
                  icon={UsersRound}
                  title="Nothing matches"
                  description="Try another filter or search term."
                  actions={
                    <Button
                      size="sm"
                      onClick={() => {
                        setQuery('')
                        setFilter('all')
                      }}
                    >
                      Clear filters
                    </Button>
                  }
                />
              }
            />
          </Panel>

          <div className="flex min-w-0 flex-col gap-4 @5xl:sticky @5xl:top-4 @5xl:self-start">
            {active?.kind === 'account' ? (
              <AccountDetailsPanel
                key={active.account.id}
                account={active.account}
                pending={active.account.profile ? pending[active.account.profile.externalId] : undefined}
                canOperate={canOperate}
                busy={busy}
                onEdit={() => setDialog({ account: active.account, profileId: null })}
                onLink={() => setLinking(active.account)}
                onUnlink={() => setConfirm({ action: 'unlink', ids: [active.account.id], labels: [active.account.label] })}
                onToggleEnabled={(enabled) => setEnabled([active.account.id], enabled)}
                onRemove={() => setConfirm({ action: 'remove', ids: [active.account.id], labels: [active.account.label] })}
                onOpenProfile={() => operate(active.account, 'open')}
                onCloseProfile={() => setConfirm({ action: 'close', account: active.account })}
                onDismiss={() => setActiveKey(null)}
              />
            ) : active?.kind === 'profile' ? (
              <UnlinkedProfilePanel
                key={active.profile.id}
                profile={active.profile}
                candidates={accountList.filter((a) => !a.profile)}
                onCreate={() => setDialog({ account: null, profileId: active.profile.id })}
                onLinked={(account) => setActiveKey(`a:${account.id}`)}
                onDismiss={() => setActiveKey(null)}
              />
            ) : (
              <Panel title="Details">
                <p className="text-sm text-fg-subtle">Select an account or profile to see its details and activity.</p>
                <p className="mt-3 text-xs text-fg-faint">
                  Usernames are only shown when you entered them. X Auto doesn’t read X identities from browser profiles.
                </p>
              </Panel>
            )}
          </div>
        </div>
      )}

      <AccountDialog
        open={Boolean(dialog)}
        account={dialog?.account ?? null}
        initialProfileId={dialog?.profileId ?? null}
        profiles={profileList}
        accounts={accountList}
        onClose={() => setDialog(null)}
        onSaved={(account) => {
          setDialog(null)
          setActiveKey(`a:${account.id}`)
        }}
      />
      <LinkProfileDialog account={linking} profiles={profileList} accounts={accountList} onClose={() => setLinking(null)} />
      <ConfirmDialog
        open={Boolean(confirm)}
        busy={busy}
        tone="danger"
        title={confirmTitle(confirm)}
        description={confirmDescription(confirm)}
        confirmLabel={confirm?.action === 'remove' ? 'Remove' : confirm?.action === 'unlink' ? 'Unlink' : 'Close profile'}
        onCancel={() => setConfirm(null)}
        onConfirm={onConfirm}
      />
    </div>
  )
}

function confirmTitle(c: Confirm | null): string {
  if (!c) return ''
  if (c.action === 'close') return `Close the profile for “${c.account.label}”?`
  const what = c.ids.length === 1 ? `“${c.labels[0]}”` : `${c.ids.length} accounts`
  return c.action === 'remove' ? `Remove ${what}?` : `Unlink ${what} from ${c.ids.length === 1 ? 'its profile' : 'their profiles'}?`
}

function confirmDescription(c: Confirm | null) {
  if (!c) return undefined
  if (c.action === 'close') {
    return 'IX Browser will close this profile’s browser. Unsaved work in its windows — forms, drafts, uploads in progress — may be lost.'
  }
  if (c.action === 'unlink') {
    return 'Only the local association is removed. The browser profiles stay in IX Browser and can be linked again at any time.'
  }
  return (
    <>
      The local {c.ids.length === 1 ? 'record and its' : 'records and their'} activity history will be deleted. Browser profiles in IX Browser are not
      touched, and nothing changes on X. Drafts assigned to {c.ids.length === 1 ? 'it' : 'them'} become unassigned; accounts with scheduled posts are
      skipped.
    </>
  )
}

function RowProfileAction(props: {
  account: Account
  pending: 'open' | 'close' | undefined
  canOperate: boolean
  onOpen: () => void
  onClose: () => void
  onLink: () => void
}) {
  const p = props.account.profile
  const stop = (fn: () => void) => (event: React.MouseEvent) => {
    event.stopPropagation()
    fn()
  }
  if (!p) {
    return (
      <Button size="sm" variant="ghost" icon={Link2} onClick={stop(props.onLink)}>
        Link
      </Button>
    )
  }
  if (p.availability === 'unavailable') return null
  if (props.pending) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-fg-subtle">
        <Spinner size={12} /> {props.pending === 'open' ? 'Opening…' : 'Closing…'}
      </span>
    )
  }
  const running = p.runState === 'running'
  return (
    <Button size="sm" variant={running ? 'ghost' : 'secondary'} icon={running ? Power : MonitorPlay} disabled={!props.canOperate} onClick={stop(running ? props.onClose : props.onOpen)}>
      {running ? 'Close' : 'Open'}
    </Button>
  )
}

function SummaryStrip(props: {
  counts: { profiles: number; available: number; unavailable: number; linked: number; unlinkedProfiles: number; accounts: number; disabled: number }
  lastSync: string | null
  lastSyncFailed: boolean
  syncing: boolean
  configured: boolean
  refreshing: boolean
  onRefresh: () => void
  onSync: () => void
  onSetup: () => void
}) {
  const { counts } = props
  const stats: { label: string; value: string; hint: string }[] = [
    { label: 'Profiles discovered', value: formatNumber(counts.profiles), hint: 'From the last IX Browser sync' },
    { label: 'Linked accounts', value: formatNumber(counts.linked), hint: `${pluralize(counts.accounts, 'account record')}${counts.disabled ? ` · ${counts.disabled} disabled` : ''}` },
    { label: 'Unlinked profiles', value: formatNumber(counts.unlinkedProfiles), hint: 'Available, with no account' },
    { label: 'Available', value: formatNumber(counts.available), hint: counts.unavailable ? `${formatNumber(counts.unavailable)} no longer reported` : 'None missing' }
  ]
  return (
    <section aria-label="Account summary" className="flex flex-wrap items-stretch overflow-hidden rounded-lg border border-line bg-surface-2 shadow-[inset_0_1px_0_var(--highlight)]">
      <dl className="grid min-w-0 basis-full grid-cols-2 @3xl:grid-cols-4 @5xl:basis-0 @5xl:flex-1">
        {stats.map((stat) => (
          <div key={stat.label} className="-mb-px -mr-px flex min-w-0 flex-col gap-1 border-b border-r border-line px-4 py-3">
            <dt className="truncate text-xs text-fg-subtle">{stat.label}</dt>
            <dd className="tabular text-xl font-semibold leading-tight tracking-[-0.015em] text-fg">{stat.value}</dd>
            <dd className="truncate text-2xs text-fg-faint">{stat.hint}</dd>
          </div>
        ))}
      </dl>
      <div className="flex min-w-[240px] flex-1 items-center justify-between gap-3 border-t border-line px-4 py-3 @5xl:flex-none @5xl:border-t-0">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-fg-subtle">Last sync</span>
          <span className={cn('truncate text-sm font-medium', props.lastSyncFailed ? 'text-danger' : 'text-fg')}>
            {props.syncing ? 'Syncing…' : props.lastSync ? `${props.lastSyncFailed ? 'Failed ' : ''}${formatRelative(props.lastSync)}` : 'Never'}
          </span>
        </div>
        {props.configured ? (
          <div className="flex items-center gap-1">
            <Tooltip content="Re-check which profiles are open">
              <IconButton
                icon={props.refreshing ? RotateCw : RefreshCw}
                label="Refresh profile status"
                size="sm"
                disabled={props.refreshing || props.syncing}
                onClick={props.onRefresh}
                className={props.refreshing ? '[&_svg]:animate-spin' : undefined}
                showTooltip={false}
              />
            </Tooltip>
            <Button size="sm" icon={props.syncing ? undefined : RefreshCw} loading={props.syncing} onClick={props.onSync} disabled={props.syncing}>
              Sync
            </Button>
          </div>
        ) : (
          <Button size="sm" icon={Settings2} onClick={props.onSetup}>
            Connect
          </Button>
        )}
      </div>
    </section>
  )
}

function BulkBar(props: {
  accounts: Account[]
  profiles: BrowserProfile[]
  busy: boolean
  onEnable: () => void
  onDisable: () => void
  onUnlink: () => void
  onRemove: () => void
  onCreate: () => void
  onClear: () => void
}) {
  const total = props.accounts.length + props.profiles.length
  if (total === 0) return null
  const linked = props.accounts.filter((a) => a.profile).length
  const creatable = props.profiles.filter((p) => p.availability === 'available').length
  return (
    <div role="toolbar" aria-label="Bulk actions" className="flex animate-fade-in flex-wrap items-center gap-1.5 border-b border-line bg-accent-soft/30 px-4 py-2">
      <span className="mr-2 text-xs font-medium text-fg">
        {total} selected
        {props.accounts.length > 0 && props.profiles.length > 0 && (
          <span className="font-normal text-fg-subtle">
            {' '}
            · {pluralize(props.accounts.length, 'account')}, {pluralize(props.profiles.length, 'profile')}
          </span>
        )}
      </span>
      {props.accounts.length > 0 && (
        <>
          <Button size="sm" variant="ghost" icon={ToggleRight} disabled={props.busy} onClick={props.onEnable}>
            Enable
          </Button>
          <Button size="sm" variant="ghost" icon={ToggleLeft} disabled={props.busy} onClick={props.onDisable}>
            Disable
          </Button>
          {linked > 0 && (
            <Button size="sm" variant="ghost" icon={Link2Off} disabled={props.busy} onClick={props.onUnlink}>
              Unlink{linked !== props.accounts.length ? ` (${linked})` : ''}
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={Trash2} disabled={props.busy} onClick={props.onRemove} className="hover:text-danger">
            Remove…
          </Button>
        </>
      )}
      {creatable > 0 && (
        <Button size="sm" variant="ghost" icon={CirclePlus} disabled={props.busy} onClick={props.onCreate}>
          Create {pluralize(creatable, 'account')}
        </Button>
      )}
      <span className="ml-auto flex items-center gap-2">
        {props.busy && <Spinner size={12} />}
        <IconButton icon={X} label="Clear selection" size="sm" onClick={props.onClear} />
      </span>
    </div>
  )
}

function UnlinkedProfilePanel(props: {
  profile: BrowserProfile
  candidates: Account[]
  onCreate: () => void
  onLinked: (account: Account) => void
  onDismiss: () => void
}) {
  const toast = useToast()
  const { profile: p } = props
  const [accountId, setAccountId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const available = p.availability === 'available'

  const link = async () => {
    if (!accountId) return
    setSaving(true)
    try {
      const account = await relay.accounts.link(accountId, p.id)
      toast({ tone: 'success', title: 'Profile linked', description: `${account.label} → ${p.name}` })
      props.onLinked(account)
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not link', description: errorMessage(error) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Panel
      padded={false}
      className="animate-fade-in"
      title={<span className="truncate">{p.name}</span>}
      meta={<ProfileStateBadge profile={p} />}
      actions={<IconButton icon={X} label="Close details" size="sm" onClick={props.onDismiss} />}
    >
      <dl className="flex flex-col px-4 py-1.5">
        {[
          ['Profile ID', `#${p.externalId}`],
          ['Account', 'None linked'],
          ['Last synchronised', formatRelative(p.lastSyncedAt)]
        ].map(([label, value]) => (
          <div key={label} className="flex min-h-9 items-center justify-between gap-3 border-b border-line py-1.5 text-sm last:border-0">
            <dt className="text-fg-subtle">{label}</dt>
            <dd data-selectable className="truncate text-fg">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      {available ? (
        <div className="flex flex-col gap-3 border-t border-line px-4 py-3">
          <Button variant="primary" icon={UserPlus} onClick={props.onCreate}>
            Create account for this profile
          </Button>
          {props.candidates.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-fg-subtle">Or link an existing account without a profile</span>
              <div className="flex gap-2">
                <Select<string>
                  size="sm"
                  className="min-w-0 flex-1"
                  aria-label="Account to link"
                  placeholder="Choose account…"
                  value={accountId}
                  onChange={setAccountId}
                  options={props.candidates.map((a) => ({ value: a.id, label: a.label, description: a.handle ? `@${a.handle}` : undefined }))}
                />
                <Button size="sm" icon={Link2} disabled={!accountId} loading={saving} onClick={link}>
                  Link
                </Button>
              </div>
            </div>
          )}
          <p className="text-2xs text-fg-faint">The profile name is not treated as an X username.</p>
        </div>
      ) : (
        <p className="border-t border-line px-4 py-3 text-xs text-fg-subtle">
          IX Browser did not report this profile in the last sync, so it can’t be linked. It is kept here in case it returns.
        </p>
      )}
    </Panel>
  )
}
