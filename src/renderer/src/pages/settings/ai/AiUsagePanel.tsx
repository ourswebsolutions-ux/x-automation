import { Activity } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { AiOperation } from '@shared/config/aiAdapters'
import type { AiRequestStatus, AiUsageQuery, AiUsageRecord } from '@shared/types/ai'
import type { ProviderConfig } from '@shared/types/providers'
import { DataTable, EmptyState, ErrorState, SegmentedControl, Select, StatusBadge, type Column } from '@/components/ui'
import { useAiUsage } from '@/data/ai'
import { formatDateTime, formatNumber, formatRelative } from '@/lib/format'
import { ERROR_KIND, OPERATION, REQUEST_STATUS } from './aiMeta'

type Period = '24h' | '7d' | '30d' | 'all'
const PERIOD_MS: Record<Exclude<Period, 'all'>, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 }

const columns: Column<AiUsageRecord>[] = [
  {
    id: 'at',
    header: 'When',
    width: '11%',
    sortValue: (r) => r.startedAt,
    cell: (r) => (
      <span className="tabular text-xs text-fg-subtle" title={formatDateTime(r.startedAt)}>
        {formatRelative(r.startedAt)}
      </span>
    )
  },
  { id: 'provider', header: 'Provider', width: '14%', sortValue: (r) => r.providerName, cell: (r) => <span className="truncate text-fg-muted">{r.providerName}</span> },
  { id: 'operation', header: 'Operation', width: '17%', sortValue: (r) => r.operation, cell: (r) => OPERATION[r.operation] },
  { id: 'model', header: 'Model', width: '17%', cell: (r) => <span className="truncate font-mono text-xs text-fg-subtle">{r.model ?? '—'}</span> },
  {
    id: 'status',
    header: 'Status',
    width: '27%',
    sortValue: (r) => r.status,
    cell: (r) => (
      <span className="flex min-w-0 items-center gap-1.5">
        <StatusBadge tone={REQUEST_STATUS[r.status].tone} dot>
          {REQUEST_STATUS[r.status].label}
        </StatusBadge>
        {r.errorKind && r.status === 'failed' && <span className="truncate text-2xs text-fg-subtle">{ERROR_KIND[r.errorKind]}</span>}
      </span>
    )
  },
  {
    id: 'tokens',
    header: 'Tokens',
    align: 'right',
    sortValue: (r) => r.usage?.totalTokens ?? -1,
    cell: (r) =>
      r.usage ? (
        <span className="tabular text-xs text-fg-muted" title="Reported by the provider">
          {formatNumber(r.usage.inputTokens ?? 0)} / {formatNumber(r.usage.outputTokens ?? 0)}
        </span>
      ) : (
        <span className="text-xs text-fg-faint" title="The provider reported no token usage for this request">
          —
        </span>
      )
  }
]

const imageColumns: Column<AiUsageRecord>[] = [
  ...columns.filter((c) => c.id === 'at' || c.id === 'provider' || c.id === 'model' || c.id === 'status'),
  {
    id: 'image',
    header: 'Images',
    align: 'right',
    cell: (r) => (
      <span className="tabular text-xs text-fg-muted">
        {r.imageCount ? `${r.imageCount} · ` : ''}
        {r.imageSize ?? '—'}
        {r.imageFormat ? ` · ${r.imageFormat.toUpperCase()}` : ''}
        {r.usage ? ` · ${formatNumber(r.usage.totalTokens ?? 0)} tok` : ''}
      </span>
    )
  }
]

/** AI request history with filters. Token counts are provider-reported; costs are never guessed. */
export function AiUsagePanel({ providers, imagesOnly = false }: { providers: ProviderConfig[]; imagesOnly?: boolean }) {
  const [providerId, setProviderId] = useState('all')
  const [operation, setOperation] = useState<'all' | AiOperation>(imagesOnly ? 'generate-image' : 'all')
  const [status, setStatus] = useState<'all' | AiRequestStatus>('all')
  const [period, setPeriod] = useState<Period>('7d')

  // Recomputed when filters change, so "last 24 hours" is measured from now.
  const query = useMemo<AiUsageQuery>(
    () => ({
      ...(providerId !== 'all' ? { providerId } : {}),
      ...(operation !== 'all' ? { operation } : {}),
      ...(status !== 'all' ? { status } : {}),
      ...(period !== 'all' ? { from: new Date(Date.now() - PERIOD_MS[period]).toISOString() } : {}),
      limit: 200
    }),
    [providerId, operation, status, period]
  )
  const usage = useAiUsage(query)
  const s = usage.data?.summary

  return (
    <section className="flex flex-col gap-3" aria-label="AI usage">
      <p className="text-xs text-fg-subtle text-pretty">
        Each request, newest first. Token counts are exactly what the provider reported — requests without a report show “—”.
      </p>
      <div className="rounded-lg border border-line bg-surface-2">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <Select<string>
            size="sm"
            className="w-44"
            aria-label="Filter by provider"
            value={providerId}
            onChange={setProviderId}
            options={[{ value: 'all', label: 'All providers' }, ...providers.map((p) => ({ value: p.id, label: p.name }))]}
          />
          {!imagesOnly && (
          <Select<'all' | AiOperation>
            size="sm"
            className="w-44"
            aria-label="Filter by operation"
            value={operation}
            onChange={setOperation}
            options={[
              { value: 'all', label: 'All operations' },
              { value: 'connection-test', label: OPERATION['connection-test'] },
              { value: 'list-models', label: OPERATION['list-models'] },
              { value: 'generate-text', label: OPERATION['generate-text'] },
              { value: 'generate-image', label: OPERATION['generate-image'] }
            ]}
          />
          )}
          <Select<'all' | AiRequestStatus>
            size="sm"
            className="w-36"
            aria-label="Filter by status"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'all', label: 'Any status' },
              { value: 'succeeded', label: 'Succeeded' },
              { value: 'failed', label: 'Failed' },
              { value: 'cancelled', label: 'Cancelled' }
            ]}
          />
          <SegmentedControl<Period>
            size="sm"
            className="ml-auto"
            value={period}
            onChange={setPeriod}
            options={[
              { value: '24h', label: '24 h' },
              { value: '7d', label: '7 days' },
              { value: '30d', label: '30 days' },
              { value: 'all', label: 'All' }
            ]}
          />
        </div>
        <dl className="grid grid-cols-2 border-b border-line @3xl:grid-cols-4">
          {[
            ['Requests', s ? formatNumber(s.requests) : '—', s ? `${s.succeeded} succeeded` : ''],
            ['Failed', s ? formatNumber(s.failed) : '—', s ? `${s.cancelled} cancelled` : ''],
            ['Input tokens', s ? formatNumber(s.inputTokens) : '—', s ? `from ${s.withUsage} of ${s.requests} requests` : ''],
            ['Output tokens', s ? formatNumber(s.outputTokens) : '—', 'Provider-reported only']
          ].map(([label, value, hint]) => (
            <div key={label} className="-mb-px -mr-px flex flex-col gap-0.5 border-b border-r border-line px-4 py-3">
              <dt className="text-xs text-fg-subtle">{label}</dt>
              <dd className="tabular text-lg font-semibold tracking-[-0.01em] text-fg">{value}</dd>
              <dd className="text-2xs text-fg-faint">{hint}</dd>
            </div>
          ))}
        </dl>
        {usage.status === 'error' ? (
          <ErrorState size="sm" error={usage.error} onRetry={usage.reload} />
        ) : (
          <DataTable
            aria-label="AI requests"
            density="compact"
            rows={usage.data?.records ?? []}
            columns={imagesOnly ? imageColumns : columns}
            rowKey={(r) => r.id}
            loading={!usage.data}
            initialSort={{ id: 'at', direction: 'desc' }}
            pageSize={50}
            empty={<EmptyState size="sm" icon={Activity} title="No AI requests" description="Nothing matches these filters yet." />}
          />
        )}
      </div>
    </section>
  )
}
