import { Download, Link2, Link2Off, Pencil, Plus, PlugZap, Shield, Star, Trash2, Upload, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { BrowserProfile } from '@shared/types/ixbrowser'
import type { Proxy, ProxyAssignment, ProxyScheme } from '@shared/types/proxies'
import {
  Button,
  Checkbox,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  IconButton,
  Modal,
  Notice,
  Panel,
  SearchField,
  Select,
  SkeletonRows,
  StatusBadge,
  Tabs,
  useToast,
  type Column
} from '@/components/ui'
import { useBrowserProfiles, useIxOverview } from '@/data/ixbrowser'
import { useProxies, useProxyAssignments } from '@/data/proxies'
import { errorMessage, relay } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { formatDateTime, formatRelative, pluralize } from '@/lib/format'
import { ProxyDialog } from './ProxyDialog'

type Filter = 'all' | 'working' | 'failing' | 'untested' | 'disabled'
const SCHEME_LABEL: Record<ProxyScheme, string> = { http: 'HTTP', https: 'HTTPS', socks5: 'SOCKS5' }

const statusOf = (p: Proxy): Exclude<Filter, 'all'> => (!p.enabled ? 'disabled' : !p.lastTest ? 'untested' : p.lastTest.ok ? 'working' : 'failing')

function ProxyStatus({ proxy }: { proxy: Proxy }) {
  const s = statusOf(proxy)
  if (s === 'disabled') return <StatusBadge variant="outline">Disabled</StatusBadge>
  if (s === 'untested') return <StatusBadge tone="neutral" variant="outline">Not tested</StatusBadge>
  if (s === 'working')
    return (
      <StatusBadge tone="success" dot>
        Working · {proxy.lastTest!.latencyMs} ms
      </StatusBadge>
    )
  return (
    <StatusBadge tone="danger" dot>
      Failed
    </StatusBadge>
  )
}

export function ProxiesView() {
  const toast = useToast()
  const proxies = useProxies()
  const assignments = useProxyAssignments()
  const profiles = useBrowserProfiles()
  const overview = useIxOverview()
  const [filter, setFilter] = useState<Filter>('all')
  const [scheme, setScheme] = useState<'all' | ProxyScheme>('all')
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dialog, setDialog] = useState<{ open: boolean; proxy: Proxy | null }>({ open: false, proxy: null })
  const [confirmDelete, setConfirmDelete] = useState<Proxy | null>(null)
  const [assignFor, setAssignFor] = useState<Proxy | null>(null)
  const [testing, setTesting] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const list = proxies.data ?? []
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return list.filter(
      (p) =>
        (filter === 'all' || statusOf(p) === filter) &&
        (scheme === 'all' || p.scheme === scheme) &&
        (!q || `${p.label} ${p.host}:${p.port} ${p.username ?? ''} ${p.notes}`.toLowerCase().includes(q))
    )
  }, [list, filter, scheme, query])
  const count = (f: Filter) => list.filter((p) => f === 'all' || statusOf(p) === f).length
  const active = list.find((p) => p.id === activeId) ?? null

  const test = async (ids: string[]) => {
    setTesting((t) => new Set([...t, ...ids]))
    const results = await Promise.allSettled(ids.map((id) => relay.proxies.test(id)))
    setTesting((t) => new Set([...t].filter((id) => !ids.includes(id))))
    const ok = results.filter((r) => r.status === 'fulfilled' && r.value.ok).length
    const failed = results.length - ok
    if (ids.length === 1) {
      const r = results[0]!
      if (r.status === 'rejected') toast({ tone: 'danger', title: 'Test could not run', description: errorMessage(r.reason) })
      else toast(r.value.ok ? { tone: 'success', title: 'Proxy works', description: `${r.value.verified === 'tls' ? 'TLS handshake' : 'Tunnel'} to ${r.value.target} in ${r.value.latencyMs} ms` } : { tone: 'danger', title: 'Proxy test failed', description: r.value.error ?? undefined, duration: 8000 })
    } else toast({ tone: failed ? 'warning' : 'success', title: `${ok} working, ${failed} failed` })
  }

  const doImport = async () => {
    setBusy(true)
    try {
      const r = await relay.proxies.import('http')
      if (r.cancelled) return
      const rejected = r.rejected.slice(0, 2).map((x) => `line ${x.line}: ${x.reason}`).join(' · ')
      toast({ tone: r.rejected.length ? 'warning' : 'success', title: `${pluralize(r.added, 'proxy', 'proxies')} imported`, description: [r.duplicates ? `${r.duplicates} already in the list` : '', rejected].filter(Boolean).join(' · ') || undefined, duration: 9000 })
    } catch (error) {
      toast({ tone: 'danger', title: 'Import failed', description: errorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  const doExport = async (format: 'txt' | 'csv') => {
    try {
      const r = await relay.proxies.export(format)
      if (!r.cancelled) toast({ tone: 'success', title: `Exported ${pluralize(r.count ?? 0, 'proxy', 'proxies')}`, description: `${r.fileName} · passwords are never exported` })
    } catch (error) {
      toast({ tone: 'danger', title: 'Export failed', description: errorMessage(error) })
    }
  }

  const remove = async (p: Proxy) => {
    try {
      await relay.proxies.remove(p.id)
      toast({ tone: 'success', title: 'Proxy deleted' })
      if (activeId === p.id) setActiveId(null)
    } catch (error) {
      toast({ tone: 'danger', title: 'Not deleted', description: errorMessage(error), duration: 8000 })
    } finally {
      setConfirmDelete(null)
    }
  }

  const columns: Column<Proxy>[] = [
    {
      id: 'label',
      header: 'Proxy',
      width: '25%',
      sortValue: (p) => p.label.toLowerCase(),
      cell: (p) => (
        <span className="flex min-w-0 flex-col">
          <span className={cn('flex items-center gap-1.5 truncate', p.enabled ? 'text-fg' : 'text-fg-subtle')}>
            {p.isDefault && <Star size={11} className="shrink-0 text-accent-text" aria-label="Default proxy" />}
            {p.label}
          </span>
          <span className="truncate font-mono text-2xs text-fg-faint">
            {p.host}:{p.port}
          </span>
        </span>
      )
    },
    { id: 'type', header: 'Type', width: '10%', sortValue: (p) => p.scheme, cell: (p) => <span className="text-xs text-fg-muted">{SCHEME_LABEL[p.scheme]}</span> },
    {
      id: 'auth',
      header: 'Auth',
      width: '12%',
      cell: (p) =>
        p.username ? (
          <span className="flex min-w-0 items-center gap-1 text-xs text-fg-muted">
            <Shield size={11} className={p.passwordMissing ? 'text-warning' : ''} />
            <span className="truncate">{p.username}</span>
          </span>
        ) : (
          <span className="text-xs text-fg-faint">None</span>
        )
    },
    { id: 'status', header: 'Status', width: '21%', sortValue: (p) => ['working', 'untested', 'failing', 'disabled'].indexOf(statusOf(p)), cell: (p) => (testing.has(p.id) ? <StatusBadge tone="info">Testing…</StatusBadge> : <ProxyStatus proxy={p} />) },
    {
      id: 'tested',
      header: 'Last tested',
      width: '12%',
      sortValue: (p) => p.lastTest?.testedAt ?? '',
      cell: (p) => <span className="tabular text-xs text-fg-subtle">{p.lastTest ? formatRelative(p.lastTest.testedAt) : '—'}</span>
    },
    { id: 'profiles', header: 'Profiles', align: 'right', sortValue: (p) => p.assignedProfiles, cell: (p) => <span className="tabular text-xs text-fg-muted">{p.assignedProfiles}</span> }
  ]

  if (proxies.status === 'error' && !proxies.data) return <ErrorState title="Proxies could not be loaded" error={proxies.error} onRetry={proxies.reload} />
  if (!proxies.data) return <SkeletonRows rows={4} />

  const assignedTo = (proxyId: string) => (assignments.data ?? []).filter((a) => a.proxyId === proxyId)

  return (
    <div className="flex flex-col gap-4">
      <Notice icon={Shield} title="How proxies are applied">
        A proxy is applied to an IX Browser profile through IX Browser’s own custom-proxy setting, while the profile is closed. Passwords are encrypted on this
        device and sent only to IX Browser on this computer. X Auto never rotates proxies by itself.
      </Notice>

      <div className="grid grid-cols-1 gap-4 @5xl:grid-cols-[minmax(0,1fr)_340px]">
        <Panel
          padded={false}
          title="Proxies"
          meta={<span className="tabular text-xs text-fg-subtle">{list.length}</span>}
          actions={
            <>
              <Button size="sm" variant="ghost" icon={Upload} loading={busy} onClick={doImport}>
                Import
              </Button>
              <Button size="sm" variant="ghost" icon={Download} onClick={() => doExport('csv')} disabled={!list.length} title="Export CSV (no passwords)">
                CSV
              </Button>
              <Button size="sm" variant="ghost" icon={Download} onClick={() => doExport('txt')} disabled={!list.length} title="Export TXT (no passwords)">
                TXT
              </Button>
              <Button size="sm" variant="primary" icon={Plus} onClick={() => setDialog({ open: true, proxy: null })}>
                Add proxy
              </Button>
            </>
          }
        >
          <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-line px-4 pt-1">
            <Tabs<Filter>
              aria-label="Filter proxies"
              value={filter}
              onChange={setFilter}
              className="border-b-0"
              items={[
                { value: 'all', label: 'All', count: count('all') },
                { value: 'working', label: 'Working', count: count('working') },
                { value: 'failing', label: 'Failed', count: count('failing') },
                { value: 'untested', label: 'Not tested', count: count('untested') },
                { value: 'disabled', label: 'Disabled', count: count('disabled') }
              ]}
            />
            <div className="flex items-center gap-2 pb-2">
              <Select<'all' | ProxyScheme>
                size="sm"
                className="w-28"
                aria-label="Filter by type"
                value={scheme}
                onChange={setScheme}
                options={[{ value: 'all', label: 'All types' }, { value: 'http', label: 'HTTP' }, { value: 'https', label: 'HTTPS' }, { value: 'socks5', label: 'SOCKS5' }]}
              />
              <SearchField value={query} onChange={setQuery} placeholder="Label, host or username" size="sm" className="w-52" aria-label="Search proxies" />
            </div>
          </div>
          {selected.size > 0 && (
            <div role="toolbar" aria-label="Bulk proxy actions" className="flex animate-fade-in items-center gap-1.5 border-b border-line bg-accent-soft/30 px-4 py-2">
              <span className="mr-2 text-xs font-medium text-fg">{selected.size} selected</span>
              <Button size="sm" variant="ghost" icon={PlugZap} onClick={() => test([...selected])}>
                Test
              </Button>
              <span className="flex-1" />
              <IconButton icon={X} label="Clear selection" size="sm" onClick={() => setSelected(new Set())} />
            </div>
          )}
          <DataTable
            aria-label="Proxies"
            rows={rows}
            columns={columns}
            rowKey={(p) => p.id}
            activeKey={activeId}
            onRowClick={(p) => setActiveId((c) => (c === p.id ? null : p.id))}
            initialSort={{ id: 'label', direction: 'asc' }}
            selection={{ selected, onChange: setSelected, rowLabel: (p) => p.label }}
            empty={
              list.length === 0 ? (
                <EmptyState
                  size="sm"
                  icon={Shield}
                  title="No proxies yet"
                  description="Add proxies one by one, or import a TXT/CSV list (host:port, host:port:user:pass, user:pass@host:port, scheme://…)."
                  actions={
                    <>
                      <Button size="sm" variant="primary" icon={Plus} onClick={() => setDialog({ open: true, proxy: null })}>
                        Add proxy
                      </Button>
                      <Button size="sm" icon={Upload} onClick={doImport}>
                        Import list
                      </Button>
                    </>
                  }
                />
              ) : (
                <EmptyState size="sm" icon={Shield} title="No proxies match" description="Try another filter or search." />
              )
            }
          />
        </Panel>

        <div className="flex min-w-0 flex-col gap-4 @5xl:sticky @5xl:top-4 @5xl:self-start">
          {active ? (
            <ProxyDetails
              proxy={active}
              assignments={assignedTo(active.id)}
              testing={testing.has(active.id)}
              onTest={() => test([active.id])}
              onEdit={() => setDialog({ open: true, proxy: active })}
              onDelete={() => setConfirmDelete(active)}
              onAssign={() => setAssignFor(active)}
              onDismiss={() => setActiveId(null)}
              onToggleDefault={async () => {
                await relay.proxies.setDefault(active.isDefault ? null : active.id)
                toast({ tone: 'success', title: active.isDefault ? 'Default proxy cleared' : 'Default proxy set' })
              }}
              onUnassign={async (profileId) => {
                await relay.proxies.unassign([profileId])
                toast({ tone: 'info', title: 'Unassigned locally', description: 'IX Browser keeps the profile’s current proxy setting until you change it.' })
              }}
            />
          ) : (
            <Panel title="Details">
              <p className="text-sm text-fg-subtle">Select a proxy to test it, see its last result and assign it to profiles.</p>
            </Panel>
          )}
          <DefaultPanel proxies={list} onApply={async () => {
            try {
              const r = await relay.proxies.applyDefault()
              toast({ tone: r.skipped.length ? 'warning' : 'success', title: `Default proxy applied to ${r.changed} profile${r.changed === 1 ? '' : 's'}`, description: r.skipped.length ? `${r.skipped.length} skipped — ${r.skipped[0]!.reason}` : undefined, duration: 9000 })
            } catch (error) {
              toast({ tone: 'danger', title: 'Not applied', description: errorMessage(error) })
            }
          }} />
        </div>
      </div>

      <ProxyDialog
        open={dialog.open}
        proxy={dialog.proxy}
        onClose={() => setDialog((d) => ({ ...d, open: false }))}
        onSaved={(p) => {
          setDialog({ open: false, proxy: null })
          setActiveId(p.id)
        }}
      />
      <AssignDialog proxy={assignFor} profiles={profiles.data ?? []} assignments={assignments.data ?? []} configured={Boolean(overview.data?.configured)} onClose={() => setAssignFor(null)} />
      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title={`Delete “${confirmDelete?.label ?? ''}”?`}
        description={
          confirmDelete?.assignedProfiles
            ? `It is assigned to ${confirmDelete.assignedProfiles} profile(s), so it can’t be deleted until it is unassigned.`
            : 'The proxy and its stored password are removed from this device.'
        }
        confirmLabel="Delete proxy"
        tone="danger"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && remove(confirmDelete)}
      />
    </div>
  )
}

function ProxyDetails(props: {
  proxy: Proxy
  assignments: ProxyAssignment[]
  testing: boolean
  onTest: () => void
  onEdit: () => void
  onDelete: () => void
  onAssign: () => void
  onDismiss: () => void
  onToggleDefault: () => void
  onUnassign: (profileId: string) => void
}) {
  const { proxy: p } = props
  const t = p.lastTest
  return (
    <Panel
      padded={false}
      className="animate-fade-in"
      title={<span className="truncate">{p.label}</span>}
      meta={<ProxyStatus proxy={p} />}
      actions={
        <>
          <IconButton icon={Pencil} label="Edit proxy" size="sm" onClick={props.onEdit} />
          <IconButton icon={X} label="Close details" size="sm" onClick={props.onDismiss} />
        </>
      }
    >
      <dl className="flex flex-col px-4 py-1.5 text-sm">
        {[
          ['Type', SCHEME_LABEL[p.scheme]],
          ['Address', `${p.host}:${p.port}`],
          ['Username', p.username ?? 'None'],
          ['Password', p.hasPassword ? (p.passwordMissing ? 'Stored, but unreadable on this device' : 'Stored (encrypted)') : 'None'],
          ['Added', formatDateTime(p.createdAt)]
        ].map(([label, value]) => (
          <div key={label} className="flex min-h-9 items-center justify-between gap-3 border-b border-line py-1.5 last:border-0">
            <dt className="shrink-0 text-fg-subtle">{label}</dt>
            <dd data-selectable className={cn('truncate text-right', label === 'Address' ? 'font-mono text-xs text-fg' : 'text-fg')}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-col gap-2 border-t border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <Button size="sm" icon={PlugZap} loading={props.testing} disabled={!p.enabled} onClick={props.onTest} className="flex-1">
            {t ? 'Test again' : 'Test connection'}
          </Button>
          <Button size="sm" variant="ghost" icon={Star} onClick={props.onToggleDefault}>
            {p.isDefault ? 'Default' : 'Make default'}
          </Button>
        </div>
        {t ? (
          <p className={cn('text-xs', t.ok ? 'text-fg-subtle' : 'text-danger')}>
            {t.ok
              ? `${t.verified === 'tls' ? 'Verified a TLS handshake' : 'Opened a tunnel'} to ${t.target} through the proxy in ${t.latencyMs} ms · ${formatRelative(t.testedAt)}`
              : `${t.error} · ${formatRelative(t.testedAt)}`}
          </p>
        ) : (
          <p className="text-xs text-fg-subtle">Not tested yet. The test opens a tunnel through the proxy and completes a TLS handshake with example.com.</p>
        )}
      </div>
      <div className="flex flex-col gap-2 border-t border-line px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-fg-muted">Assigned profiles</span>
          <Button size="sm" variant="ghost" icon={Link2} disabled={!p.enabled} onClick={props.onAssign}>
            Assign
          </Button>
        </div>
        {props.assignments.length === 0 ? (
          <p className="text-xs text-fg-subtle">Not assigned to any profile.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {props.assignments.map((a) => (
              <li key={a.profileId} className="flex items-center gap-2 py-1.5 text-xs">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-fg">{a.profileName}</span>
                  <span className={cn('block truncate', a.status === 'applied' ? 'text-fg-subtle' : 'text-danger')}>
                    {a.status === 'applied' ? `Applied in IX Browser ${a.appliedAt ? formatRelative(a.appliedAt) : ''}` : `Not applied: ${a.error ?? 'IX Browser refused it'}`}
                  </span>
                </span>
                <IconButton icon={Link2Off} label={`Unassign ${a.profileName}`} size="sm" onClick={() => props.onUnassign(a.profileId)} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="border-t border-line px-4 py-2.5">
        <Button size="sm" variant="ghost" icon={Trash2} onClick={props.onDelete} className="hover:text-danger">
          Delete proxy
        </Button>
      </div>
    </Panel>
  )
}

function DefaultPanel({ proxies, onApply }: { proxies: Proxy[]; onApply: () => void }) {
  const def = proxies.find((p) => p.isDefault) ?? null
  return (
    <Panel title="Default proxy">
      <p className="text-sm text-fg">{def ? def.label : 'None chosen'}</p>
      <p className="mt-1 text-xs text-fg-subtle">Pre-selected when assigning, and can be applied to every closed profile that has no proxy yet.</p>
      <Button size="sm" className="mt-3" icon={Link2} disabled={!def || !def.enabled} onClick={onApply}>
        Apply to profiles without a proxy
      </Button>
    </Panel>
  )
}

function AssignDialog(props: { proxy: Proxy | null; profiles: BrowserProfile[]; assignments: ProxyAssignment[]; configured: boolean; onClose: () => void }) {
  const toast = useToast()
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const current = new Map(props.assignments.map((a) => [a.profileId, a]))
  const available = props.profiles.filter((p) => p.availability === 'available' && (!query.trim() || `${p.name} ${p.externalId}`.toLowerCase().includes(query.trim().toLowerCase())))

  const apply = async () => {
    if (!props.proxy) return
    setSaving(true)
    try {
      const r = await relay.proxies.assign([...picked], props.proxy.id)
      toast({
        tone: r.skipped.length ? 'warning' : 'success',
        title: `Applied to ${r.changed} profile${r.changed === 1 ? '' : 's'}`,
        description: r.skipped.length ? `${r.skipped.length} not applied — ${r.skipped[0]!.reason}` : 'IX Browser accepted the proxy setting.',
        duration: 9000
      })
      setPicked(new Set())
      props.onClose()
    } catch (error) {
      toast({ tone: 'danger', title: 'Not applied', description: errorMessage(error) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={Boolean(props.proxy)}
      onClose={props.onClose}
      dismissible={!saving}
      title={`Assign “${props.proxy?.label ?? ''}”`}
      description="IX Browser applies a proxy when a profile starts, so open profiles can’t be changed — close them first."
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" icon={Link2} loading={saving} disabled={!picked.size || !props.configured} onClick={apply}>
            Apply to {picked.size || ''} profile{picked.size === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      {!props.configured && <p className="mb-3 text-xs text-warning">Needs an active IX Browser connection.</p>}
      <SearchField value={query} onChange={setQuery} placeholder="Profile name or ID" size="sm" aria-label="Search profiles" />
      <ul aria-label="Profiles" className="mt-2 max-h-72 overflow-y-auto rounded-md border border-line-strong bg-surface-1 p-1">
        {available.map((p) => {
          const running = p.runState === 'running'
          const a = current.get(p.id)
          return (
            <li key={p.id}>
              <label className={cn('flex h-9 items-center gap-2.5 rounded-sm px-2 text-sm', running ? 'opacity-60' : 'hover:bg-neutral-soft')}>
                <Checkbox
                  checked={picked.has(p.id)}
                  disabled={running}
                  aria-label={`Select ${p.name}`}
                  onChange={(on) => setPicked((s) => {
                    const next = new Set(s)
                    if (on) next.add(p.id)
                    else next.delete(p.id)
                    return next
                  })}
                />
                <span className="min-w-0 flex-1 truncate text-fg">{p.name}</span>
                {running ? <span className="text-2xs text-warning">Open — close it first</span> : a ? <span className="truncate text-2xs text-fg-subtle">Now: {a.proxyLabel}</span> : null}
                <span className="tabular font-mono text-2xs text-fg-faint">#{p.externalId}</span>
              </label>
            </li>
          )
        })}
        {available.length === 0 && <p className="px-2 py-3 text-xs text-fg-subtle">No available profiles. Sync IX Browser profiles first.</p>}
      </ul>
    </Modal>
  )
}
