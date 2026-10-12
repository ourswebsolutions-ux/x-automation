import {
  CircleCheck,
  CircleDashed,
  Link2,
  Link2Off,
  CircleSlash,
  CircleX,
  Globe,
  LayoutGrid,
  MonitorPlay,
  PlugZap,
  Power,
  RefreshCw,
  RotateCw,
  Settings2,
  X
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import type { Account } from '@shared/types/accounts'
import type { BrowserProfile, IxBrowserOverview, SyncRun } from '@shared/types/ixbrowser'
import {
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  IconButton,
  LiveBadge,
  MetricCard,
  Notice,
  Panel,
  SearchField,
  SkeletonRows,
  Spinner,
  StatusBadge,
  StatusDot,
  Tabs,
  Tooltip,
  useToast,
  type Column
} from '@/components/ui'
import { useAccounts } from '@/data/accounts'
import { useBrowserProfiles, useIxOverview, useSyncHistory, useSyncProgress } from '@/data/ixbrowser'
import { useQueryParam } from '@/hooks/useQueryParam'
import { errorMessage, relay } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { formatDateTime, formatNumber, formatRelative } from '@/lib/format'
import { settingsPath } from '@/app/navigation'
import { CompatibilityPanel } from './CompatibilityPanel'
import { ProfileStateBadge } from './ProfileStateBadge'

/**
 * Whether a profile is ready for Create Post and Campaigns. Syncing links every available profile
 * to an account automatically; a profile you disconnected stays out until you connect it again.
 */
function linkState(p: BrowserProfile, account: Account | null, linkError: string | null): { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral'; hint: string } {
  if (p.availability === 'unavailable') return { label: 'Unavailable', tone: 'neutral', hint: 'IX Browser no longer reports this profile, so it is left out until it is reported again.' }
  if (account?.enabled) return { label: 'Connected', tone: 'success', hint: 'Used by Create Post and Campaigns.' }
  if (account) return { label: 'Disabled', tone: 'warning', hint: 'Its account is disabled for tasks (X accounts tab), so it is left out.' }
  if (p.linkExcludedAt) return { label: 'Disconnected', tone: 'neutral', hint: `You disconnected it ${formatRelative(p.linkExcludedAt)}. Syncs leave it out until you connect it again.` }
  if (linkError) return { label: 'Link failed', tone: 'danger', hint: `${linkError} Sync again to retry.` }
  return { label: 'Not linked yet', tone: 'neutral', hint: 'It is linked automatically on the next sync.' }
}

type Filter = 'all' | 'running' | 'closed' | 'new' | 'unavailable'

const matches = (p: BrowserProfile, filter: Filter) =>
  filter === 'all' ||
  (filter === 'running' && p.availability === 'available' && p.runState === 'running') ||
  (filter === 'closed' && p.availability === 'available' && p.runState !== 'running') ||
  (filter === 'new' && p.lastChange === 'new') ||
  (filter === 'unavailable' && p.availability === 'unavailable')

function ChangeBadge({ change }: { change: BrowserProfile['lastChange'] }) {
  if (change === 'new') return <StatusBadge tone="accent">New</StatusBadge>
  if (change === 'updated') return <StatusBadge tone="info">Updated</StatusBadge>
  return null
}

export function ProfilesView() {
  const navigate = useNavigate()
  const toast = useToast()
  const overview = useIxOverview()
  const profiles = useBrowserProfiles()
  const history = useSyncHistory()
  const accounts = useAccounts()
  const o = overview.data
  const progress = useSyncProgress(Boolean(o?.syncing))
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useQueryParam('q')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [testing, setTesting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [confirmClose, setConfirmClose] = useState<BrowserProfile | null>(null)

  const list = profiles.data ?? []
  const selected = list.find((p) => p.externalId === selectedId) ?? null
  const pending = o?.pending ?? {}
  const accountOf = useMemo(() => {
    const byProfile = new Map((accounts.data ?? []).filter((a) => a.profile).map((a) => [a.profile!.id, a]))
    return (p: BrowserProfile) => byProfile.get(p.id) ?? null
  }, [accounts.data])
  const linkErrorOf = (p: BrowserProfile) => o?.lastSync?.linkErrors.find((e) => e.profileId === p.id)?.reason ?? null
  const connected = list.filter((p) => linkState(p, accountOf(p), null).label === 'Connected').length

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return list.filter((p) => matches(p, filter) && (!q || p.name.toLowerCase().includes(q) || String(p.externalId).includes(q)))
  }, [list, filter, query])
  const count = (f: Filter) => list.filter((p) => matches(p, f)).length

  const test = async () => {
    setTesting(true)
    try {
      const result = await relay.ixbrowser.testConnection()
      if (result.ok) toast({ tone: 'success', title: 'Connected to IX Browser', description: `${result.totalProfiles} profiles · ${result.latencyMs} ms` })
      else toast({ tone: 'danger', title: 'Connection failed', description: result.error?.message, duration: 8000 })
    } catch (error) {
      toast({ tone: 'danger', title: 'Connection test failed', description: errorMessage(error) })
    } finally {
      setTesting(false)
    }
  }

  const sync = async () => {
    try {
      const run = await relay.ixbrowser.sync()
      accounts.reload()
      profiles.reload()
      toast({
        tone: run.linkFailed ? 'warning' : 'success',
        title: 'Profiles synchronized',
        description: `${run.discovered} found · ${run.added} new · ${run.linked} linked automatically · ${run.unavailable} unavailable${run.linkFailed ? ` · ${run.linkFailed} could not be linked — sync again to retry` : ''}`,
        duration: run.linkFailed ? 9000 : undefined
      })
    } catch (error) {
      const message = errorMessage(error)
      if (!message.startsWith('Cancelled')) toast({ tone: 'danger', title: 'Sync failed', description: message, duration: 9000 })
      else toast({ tone: 'info', title: 'Sync cancelled' })
    }
  }

  /** Disconnect: the profile's account is unlinked and syncs leave it alone. Connect: the same account is linked again (a new record if it was removed). */
  const setConnected = async (profile: BrowserProfile, connect: boolean) => {
    try {
      const account = accountOf(profile)
      const result = connect ? (await relay.accounts.connectProfile(profile.id), null) : account ? await relay.accounts.unlink([account.id]) : null
      const skipped = result?.skipped[0]?.reason
      if (skipped) toast({ tone: 'warning', title: connect ? 'Not connected' : 'Not disconnected', description: skipped })
      else toast({ tone: 'success', title: connect ? `“${profile.name}” connected` : `“${profile.name}” disconnected`, description: connect ? 'Create Post and Campaigns use it from now on.' : 'Create Post and Campaigns leave it out. The browser profile itself was not changed.' })
    } catch (error) {
      toast({ tone: 'danger', title: connect ? 'Could not connect the profile' : 'Could not disconnect the profile', description: errorMessage(error) })
    } finally {
      accounts.reload()
      profiles.reload()
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

  const operate = async (profile: BrowserProfile, operation: 'open' | 'close') => {
    try {
      const result =
        operation === 'open' ? await relay.ixbrowser.openProfile(profile.externalId) : await relay.ixbrowser.closeProfile(profile.externalId)
      toast({
        tone: result.confirmed ? 'success' : 'warning',
        title: `${operation === 'open' ? 'Opened' : 'Closed'} “${profile.name}”`,
        description: result.confirmed ? undefined : 'IX Browser accepted the request, but its status list did not confirm the change yet.'
      })
    } catch (error) {
      toast({ tone: 'danger', title: `Could not ${operation} “${profile.name}”`, description: errorMessage(error), duration: 8000 })
    }
  }

  if (overview.status === 'error') return <ErrorState title="IX Browser status unavailable" error={overview.error} onRetry={overview.reload} />
  if (!o) return <SkeletonRows rows={4} />

  if (!o.configured && list.length === 0) {
    return (
      <Panel>
        <EmptyState
          icon={Globe}
          title="Connect IX Browser to see your profiles"
          description={
            <>
              X Auto reads your browser profiles through IX Browser’s Local API. Open IX Browser, enable the Local API in its settings,
              then add the connection here. No profiles are shown until a real connection succeeds.
            </>
          }
          actions={
            <Button variant="primary" icon={Settings2} onClick={() => navigate(settingsPath('ixbrowser'))}>
              Set up IX Browser connection
            </Button>
          }
        />
      </Panel>
    )
  }

  const columns: Column<BrowserProfile>[] = [
    {
      id: 'name',
      header: 'Profile',
      width: '30%',
      sortValue: (p) => p.name.toLowerCase(),
      cell: (p) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn('truncate', p.availability === 'unavailable' ? 'text-fg-subtle line-through decoration-fg-faint' : 'text-fg')}>{p.name}</span>
          <ChangeBadge change={p.lastChange} />
        </span>
      )
    },
    { id: 'id', header: 'ID', width: '9%', sortValue: (p) => p.externalId, cell: (p) => <span className="tabular font-mono text-xs text-fg-muted">#{p.externalId}</span> },
    { id: 'status', header: 'Status', width: '13%', sortValue: (p) => (p.availability === 'unavailable' ? 3 : p.runState === 'running' ? 0 : 1), cell: (p) => <ProfileStateBadge profile={p} /> },
    {
      id: 'link',
      header: 'Posting',
      width: '15%',
      sortValue: (p) => linkState(p, accountOf(p), linkErrorOf(p)).label,
      cell: (p) => {
        const state = linkState(p, accountOf(p), linkErrorOf(p))
        return (
          <Tooltip content={state.hint}>
            <span>
              <StatusBadge tone={state.tone} dot={state.tone !== 'neutral'}>
                {state.label}
              </StatusBadge>
            </span>
          </Tooltip>
        )
      }
    },
    { id: 'synced', header: 'Last synced', width: '14%', sortValue: (p) => p.lastSyncedAt, cell: (p) => <span className="tabular text-xs text-fg-subtle">{formatRelative(p.lastSyncedAt)}</span> },
    {
      id: 'actions',
      header: '',
      align: 'right',
      cell: (p) => <ProfileAction profile={p} pending={pending[p.externalId]} disabled={!o.configured} onOpen={() => operate(p, 'open')} onClose={() => setConfirmClose(p)} />
    }
  ]

  return (
    <div className="flex flex-col gap-4">
      {!o.configured && (
        <Notice
          tone="warning"
          title="No active IX Browser connection"
          actions={
            <Button size="sm" onClick={() => navigate(settingsPath('ixbrowser'))}>
              Connection settings
            </Button>
          }
        >
          These profiles are from an earlier sync. Add or enable a connection to refresh them or open and close profiles.
        </Notice>
      )}

      {o.configured && (
        <ConnectionBar overview={o} testing={testing} progress={progress} onTest={test} onSync={sync} onCancel={() => relay.ixbrowser.cancelSync()} />
      )}

      <div className="grid grid-cols-2 gap-3 @4xl:grid-cols-4">
        <MetricCard label="Profiles discovered" icon={LayoutGrid} value={o.counts.total} hint={o.counts.unavailable ? `${o.counts.unavailable} no longer in IX Browser` : 'From the last sync'} />
        <MetricCard label="Connected" icon={CircleCheck} value={connected} hint={`Ready for Create Post and Campaigns · ${o.counts.available} available`} />
        <MetricCard label="Running" icon={MonitorPlay} value={o.counts.running} hint="From IX Browser’s opened-profile lists" />
        <SyncTile run={o.lastSync} syncing={o.syncing} />
      </div>

      <div className="grid grid-cols-1 gap-4 @5xl:grid-cols-[minmax(0,1fr)_340px]">
        <Panel padded={false} meta={<LiveBadge />} title="Browser profiles" actions={
          <Tooltip content={o.configured ? 'Re-check which profiles are open' : 'Needs an active connection'}>
            <IconButton icon={refreshing ? RotateCw : RefreshCw} label="Refresh status" size="sm" disabled={!o.configured || refreshing || o.syncing} onClick={refreshStatus} className={refreshing ? '[&_svg]:animate-spin' : undefined} showTooltip={false} />
          </Tooltip>
        }>
          <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-line px-4 pt-1">
            <Tabs<Filter>
              aria-label="Filter profiles"
              value={filter}
              onChange={setFilter}
              className="border-b-0"
              items={[
                { value: 'all', label: 'All', count: list.length },
                { value: 'running', label: 'Running', count: count('running') },
                { value: 'closed', label: 'Closed', count: count('closed') },
                { value: 'new', label: 'New', count: count('new') },
                { value: 'unavailable', label: 'Unavailable', count: count('unavailable') }
              ]}
            />
            <div className="pb-2">
              <SearchField value={query} onChange={setQuery} placeholder="Name or ID" size="sm" className="w-52" aria-label="Search profiles" />
            </div>
          </div>
          {profiles.status === 'error' ? (
            <ErrorState size="sm" error={profiles.error} onRetry={profiles.reload} />
          ) : (
            <DataTable
              aria-label="Browser profiles"
              rows={rows}
              columns={columns}
              rowKey={(p) => p.id}
              loading={!profiles.data}
              onRowClick={(p) => setSelectedId(p.externalId)}
              initialSort={{ id: 'name', direction: 'asc' }}
              pageSize={100}
              empty={
                list.length === 0 ? (
                  <EmptyState
                    size="sm"
                    icon={CircleDashed}
                    title="No profiles synced yet"
                    description="Run a sync to load the profiles from IX Browser."
                    actions={
                      <Button size="sm" variant="primary" icon={RefreshCw} disabled={o.syncing} onClick={sync}>
                        Sync profiles
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState size="sm" icon={CircleDashed} title="No profiles match" description="Try another filter or search." />
                )
              }
            />
          )}
        </Panel>

        <div className="flex min-w-0 flex-col gap-4">
          {selected ? (
            <ProfileDetails
              profile={selected}
              account={accountOf(selected)}
              linkError={linkErrorOf(selected)}
              onConnect={() => setConnected(selected, true)}
              onDisconnect={() => setConnected(selected, false)}
              onShowAccount={(id) => navigate(`/accounts?view=accounts&q=${encodeURIComponent(id)}`)}
              pending={pending[selected.externalId]}
              canOperate={o.configured}
              onOpen={() => operate(selected, 'open')}
              onClose={() => setConfirmClose(selected)}
              onDismiss={() => setSelectedId(null)}
            />
          ) : (
            <Panel title="Details">
              <p className="text-sm text-fg-subtle">Select a profile to see its details.</p>
            </Panel>
          )}
          {selected && <CompatibilityPanel profile={selected} configured={o.configured} />}
          <SyncHistory runs={history.data ?? null} onRetry={sync} syncing={o.syncing} configured={o.configured} />
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(confirmClose)}
        title={`Close “${confirmClose?.name ?? ''}”?`}
        description="IX Browser will close this profile’s browser. Unsaved work in its windows — forms, drafts, uploads in progress — may be lost."
        confirmLabel="Close profile"
        tone="danger"
        onCancel={() => setConfirmClose(null)}
        onConfirm={() => {
          const profile = confirmClose
          setConfirmClose(null)
          if (profile) void operate(profile, 'close')
        }}
      />
    </div>
  )
}

function ProfileAction(props: { profile: BrowserProfile; pending: 'open' | 'close' | undefined; disabled: boolean; onOpen: () => void; onClose: () => void }) {
  const { profile, pending, disabled } = props
  if (profile.availability === 'unavailable') return null
  if (pending) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-fg-subtle">
        <Spinner size={12} /> {pending === 'open' ? 'Opening…' : 'Closing…'}
      </span>
    )
  }
  const running = profile.runState === 'running'
  return (
    <Button
      size="sm"
      variant={running ? 'ghost' : 'secondary'}
      icon={running ? Power : MonitorPlay}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation()
        if (running) props.onClose()
        else props.onOpen()
      }}
    >
      {running ? 'Close' : 'Open'}
    </Button>
  )
}

function ConnectionBar({
  overview,
  testing,
  progress,
  onTest,
  onSync,
  onCancel
}: {
  overview: IxBrowserOverview
  testing: boolean
  progress: ReturnType<typeof useSyncProgress>
  onTest: () => void
  onSync: () => void
  onCancel: () => void
}) {
  const t = overview.lastTest
  const tone = !t ? 'neutral' : t.ok ? 'success' : 'danger'
  const title = !t ? 'Not tested yet' : t.ok ? 'Connected' : 'Connection failed'
  const ratio = progress?.total ? Math.min(progress.fetched / progress.total, 1) : null

  return (
    <section className="relative overflow-hidden rounded-lg border border-line bg-surface-2">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3.5">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span
            className={cn(
              'mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border',
              tone === 'success' && 'border-success/30 bg-success-soft text-success',
              tone === 'danger' && 'border-danger/30 bg-danger-soft text-danger',
              tone === 'neutral' && 'border-line-strong bg-surface-3 text-fg-muted'
            )}
          >
            {tone === 'success' ? <CircleCheck size={15} /> : tone === 'danger' ? <CircleX size={15} /> : <PlugZap size={15} />}
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-2 text-sm font-medium text-fg">
              {title}
              <span className="font-normal text-fg-subtle">· {overview.providerName}</span>
            </span>
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-fg-subtle">
              <span className="font-mono">{overview.endpoint}/api/v2</span>
              {t?.ok && t.latencyMs !== null && <span>· {t.latencyMs} ms</span>}
              {t && <span>· checked {formatRelative(t.checkedAt)}</span>}
            </span>
            {t && !t.ok && t.error && (
              <span className="mt-1 text-xs text-danger">
                {t.error.message} <span className="text-fg-subtle">{t.error.hint}</span>
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {overview.syncing ? (
            <>
              <span className="flex items-center gap-2 text-xs text-fg-muted">
                <Spinner size={13} />
                {progress?.stage === 'status'
                  ? 'Checking which profiles are open…'
                  : progress?.stage === 'saving'
                    ? 'Saving…'
                    : progress?.total
                      ? `Fetched ${formatNumber(progress.fetched)} of ${formatNumber(progress.total)}`
                      : 'Contacting IX Browser…'}
              </span>
              <Button size="sm" variant="ghost" icon={X} onClick={onCancel}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" icon={PlugZap} loading={testing} onClick={onTest}>
                Test connection
              </Button>
              <Button size="sm" variant="primary" icon={RefreshCw} onClick={onSync}>
                Sync profiles
              </Button>
            </>
          )}
        </div>
      </div>
      {overview.syncing && (
        <div className="absolute inset-x-0 bottom-0 h-0.5 bg-line" aria-hidden>
          <div
            className={cn('h-full bg-accent transition-[width] duration-300', ratio === null && 'w-1/3 animate-[shimmer_1.2s_linear_infinite]')}
            style={ratio === null ? undefined : { width: `${Math.max(ratio * 100, 4)}%` }}
          />
        </div>
      )}
    </section>
  )
}

function SyncTile({ run, syncing }: { run: SyncRun | null; syncing: boolean }) {
  const failed = run?.status === 'failed'
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface-2 p-4 shadow-[inset_0_1px_0_var(--highlight)]">
      <span className="flex items-center gap-2 text-xs font-medium text-fg-muted">
        <RefreshCw size={14} strokeWidth={1.8} className="text-fg-subtle" /> Last sync
      </span>
      <span className="truncate text-lg font-semibold tracking-[-0.01em] text-fg">
        {syncing ? 'Syncing…' : run?.finishedAt ? formatRelative(run.finishedAt) : 'Never'}
      </span>
      <span className="flex min-h-4 items-center gap-1.5 truncate text-xs text-fg-subtle">
        {run && !syncing && (
          <>
            <StatusDot tone={failed ? 'danger' : run.status === 'cancelled' ? 'warning' : 'success'} />
            {failed ? 'Failed' : run.status === 'cancelled' ? 'Cancelled' : `${run.discovered} profiles`}
          </>
        )}
      </span>
    </div>
  )
}

function ProfileDetails(props: {
  profile: BrowserProfile
  account: Account | null
  linkError: string | null
  onConnect: () => void
  onDisconnect: () => void
  onShowAccount: (search: string) => void
  pending: 'open' | 'close' | undefined
  canOperate: boolean
  onOpen: () => void
  onClose: () => void
  onDismiss: () => void
}) {
  const { profile: p } = props
  const rows: [string, string][] = [
    ['Profile ID', `#${p.externalId}`],
    ['Availability', p.availability === 'available' ? 'Reported by IX Browser' : 'No longer reported'],
    [
      'Run state',
      p.runState === 'running'
        ? `Running · opened by ${p.openedBy === 'api' ? 'the Local API' : 'the IX Browser app'}`
        : p.runState === 'closed'
          ? 'Closed'
          : 'Unknown'
    ],
    ['Status checked', p.statusCheckedAt ? formatDateTime(p.statusCheckedAt) : '—'],
    ['First discovered', formatDateTime(p.firstSeenAt)],
    ['Last synced', formatDateTime(p.lastSyncedAt)]
  ]
  const metadata = Object.entries(p.metadata)

  return (
    <Panel
      title={<span className="truncate">{p.name}</span>}
      meta={<ProfileStateBadge profile={p} />}
      actions={<IconButton icon={X} label="Close details" size="sm" onClick={props.onDismiss} />}
      padded={false}
      className="animate-fade-in"
    >
      <dl className="flex flex-col px-4 py-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex min-h-9 items-center justify-between gap-3 border-b border-line py-1.5 text-sm last:border-0">
            <dt className="shrink-0 text-fg-subtle">{label}</dt>
            <dd data-selectable className="truncate text-right text-fg">
              {value}
            </dd>
          </div>
        ))}
        {p.siteUrl && (
          <div className="flex min-h-9 items-center justify-between gap-3 border-b border-line py-1.5 text-sm last:border-0">
            <dt className="shrink-0 text-fg-subtle">Start page</dt>
            <dd data-selectable className="truncate font-mono text-xs text-fg-muted" title={p.siteUrl}>
              {p.siteUrl}
            </dd>
          </div>
        )}
      </dl>
      <div className="flex flex-col gap-2 border-t border-line px-4 py-2.5 text-sm">
        <div className="flex min-h-6 items-center justify-between gap-3">
          <span className="shrink-0 text-fg-subtle">Posting</span>
          <StatusBadge tone={linkState(p, props.account, props.linkError).tone} dot>
            {linkState(p, props.account, props.linkError).label}
          </StatusBadge>
        </div>
        <p className="text-xs text-fg-subtle">{linkState(p, props.account, props.linkError).hint}</p>
        <div className="flex min-h-6 items-center justify-between gap-3">
          <span className="shrink-0 text-fg-subtle">Account</span>
          {props.account ? (
            <button
              type="button"
              onClick={() => props.onShowAccount(props.account!.label)}
              className="truncate rounded-xs text-right text-accent-text hover:underline focus-ring"
            >
              {props.account.label}
              {props.account.handle && <span className="text-fg-subtle"> · @{props.account.handle}</span>}
            </button>
          ) : (
            <span className="text-fg-subtle">None</span>
          )}
        </div>
        {p.availability === 'available' && (
          <div className="flex justify-end">
            {props.account ? (
              <Button size="sm" variant="ghost" icon={Link2Off} disabled={Boolean(props.pending)} onClick={props.onDisconnect}>
                Disconnect
              </Button>
            ) : (
              <Button size="sm" variant="secondary" icon={Link2} onClick={props.onConnect}>
                Connect
              </Button>
            )}
          </div>
        )}
      </div>
      {metadata.length > 0 && (
        <div className="border-t border-line px-4 py-3">
          <p className="pb-2 text-2xs font-medium uppercase tracking-[0.07em] text-fg-faint">Other fields from IX Browser</p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            {metadata.map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="font-mono text-2xs text-fg-subtle">{key}</dt>
                <dd data-selectable className="truncate font-mono text-2xs text-fg-muted">
                  {String(value)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {p.availability === 'available' && (
        <div className="flex items-center gap-2 border-t border-line px-4 py-3">
          {props.pending ? (
            <span className="flex items-center gap-2 text-sm text-fg-muted">
              <Spinner size={13} /> {props.pending === 'open' ? 'Opening profile…' : 'Closing profile…'}
            </span>
          ) : p.runState === 'running' ? (
            <Button icon={Power} disabled={!props.canOperate} onClick={props.onClose} className="flex-1">
              Close profile
            </Button>
          ) : (
            <Button variant="primary" icon={MonitorPlay} disabled={!props.canOperate} onClick={props.onOpen} className="flex-1">
              Open profile
            </Button>
          )}
        </div>
      )}
    </Panel>
  )
}

function SyncHistory({ runs, onRetry, syncing, configured }: { runs: SyncRun[] | null; onRetry: () => void; syncing: boolean; configured: boolean }) {
  const latestFailed = runs?.[0]?.status === 'failed' || (runs?.[0]?.linkFailed ?? 0) > 0
  return (
    <Panel
      title="Sync history"
      padded={false}
      actions={
        latestFailed &&
        configured && (
          <Button size="sm" variant="ghost" icon={RotateCw} disabled={syncing} onClick={onRetry}>
            Retry
          </Button>
        )
      }
    >
      {!runs ? (
        <SkeletonRows rows={2} className="p-4" />
      ) : runs.length === 0 ? (
        <p className="px-4 py-4 text-sm text-fg-subtle">No syncs yet.</p>
      ) : (
        <ul className="flex flex-col px-4 py-1.5">
          {runs.slice(0, 6).map((run) => (
            <li key={run.id} className="flex gap-2.5 border-b border-line py-2.5 last:border-0">
              {run.status === 'succeeded' ? (
                <CircleCheck size={14} className="mt-0.5 shrink-0 text-success" />
              ) : run.status === 'failed' ? (
                <CircleX size={14} className="mt-0.5 shrink-0 text-danger" />
              ) : run.status === 'cancelled' ? (
                <CircleSlash size={14} className="mt-0.5 shrink-0 text-warning" />
              ) : (
                <Spinner size={14} className="mt-0.5 shrink-0" />
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-baseline justify-between gap-2 text-sm text-fg">
                  {run.status === 'succeeded' ? `${run.discovered} profiles` : run.status === 'failed' ? 'Failed' : run.status === 'cancelled' ? 'Cancelled' : 'Running'}
                  <span className="tabular shrink-0 text-2xs text-fg-faint">{formatRelative(run.startedAt)}</span>
                </span>
                {run.status === 'succeeded' && (
                  <span className="text-xs text-fg-subtle">
                    {run.added} new · {run.updated} updated · {run.unavailable} unavailable
                    {run.linked > 0 && ` · ${run.linked} linked`}
                    {run.duplicates > 0 && ` · ${run.duplicates} duplicate${run.duplicates === 1 ? '' : 's'} ignored`}
                  </span>
                )}
                {run.linkErrors.slice(0, 5).map((e) => (
                  <span key={e.profileId} className="break-words text-xs text-danger">
                    Not linked: {e.name} — {e.reason}
                  </span>
                ))}
                {run.linkFailed > 5 && <span className="text-xs text-danger">…and {run.linkFailed - 5} more</span>}
                {run.error && <span className="break-words text-xs text-danger">{run.error}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}
