import { Gauge, Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ProviderConfig } from '@shared/types/providers'
import type { UsageLimit, UsageLimitInput, UsageMetric, UsageRate, UsageRow } from '@shared/types/usage'
import { Button, ConfirmDialog, EmptyState, Field, IconButton, Input, Modal, SegmentedControl, Select, SettingsSection, Skeleton, Textarea, useToast } from '@/components/ui'
import { useProviders } from '@/data/providers'
import { useAsync } from '@/hooks/useAsync'
import { errorMessage, relay } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { formatNumber } from '@/lib/format'
import { AiUsagePanel } from './ai/AiUsagePanel'

type Range = 'today' | '7d' | '30d' | 'month' | 'custom'
type Breakdown = 'day' | 'month' | 'provider' | 'type'

const pad = (n: number) => String(n).padStart(2, '0')
const dateInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const money = (n: number | null) => (n === null ? '—' : n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`)
const METRIC: Record<UsageMetric, string> = { requests: 'Requests', tokens: 'Tokens', images: 'Images', 'estimated-cost': 'Estimated cost (USD)' }

function rangeBounds(range: Range, from: string, to: string): { from: string; to: string } {
  const now = new Date()
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
  switch (range) {
    case 'today':
      return { from: startOfDay(now).toISOString(), to: now.toISOString() }
    case '7d':
      return { from: new Date(startOfDay(now).getTime() - 6 * 86_400_000).toISOString(), to: now.toISOString() }
    case '30d':
      return { from: new Date(startOfDay(now).getTime() - 29 * 86_400_000).toISOString(), to: now.toISOString() }
    case 'month':
      return { from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(), to: now.toISOString() }
    case 'custom': {
      const a = new Date(`${from}T00:00:00`)
      const b = new Date(`${to}T23:59:59`)
      return { from: a.toISOString(), to: b.toISOString() }
    }
  }
}

/**
 * Settings → Usage & costs. Counts and tokens are exactly what providers
 * reported; costs are estimates from rates the user enters (providers don't
 * include prices in their responses), and are always labelled as estimates.
 */
export function UsageSection() {
  const providers = useProviders()
  const aiProviders = (providers.data ?? []).filter((p) => p.kind === 'openai-compatible' || p.kind === 'image')
  const [range, setRange] = useState<Range>('30d')
  const [from, setFrom] = useState(dateInput(new Date(Date.now() - 6 * 86_400_000)))
  const [to, setTo] = useState(dateInput(new Date()))
  const [providerId, setProviderId] = useState('all')
  const [breakdown, setBreakdown] = useState<Breakdown>('day')
  const bounds = rangeBounds(range, from, to)
  const valid = bounds.from <= bounds.to && !Number.isNaN(Date.parse(bounds.from))
  const report = useAsync(
    () => (valid ? relay.usage.report({ ...bounds, ...(providerId !== 'all' ? { providerId } : {}) }) : Promise.resolve(null)),
    [bounds.from.slice(0, 16), bounds.to.slice(0, 16), providerId, valid]
  )
  useEffect(() => relay.integrations.onChange(report.reload), [report.reload])
  const t = report.data?.totals
  const rows: UsageRow[] = report.data ? { day: report.data.byDay, month: report.data.byMonth, provider: report.data.byProvider, type: report.data.byOperation }[breakdown] : []
  const max = Math.max(1, ...rows.map((r) => r.requests))

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-medium text-fg">Usage & costs</h2>
        <p className="text-sm text-fg-subtle text-pretty">
          Every AI request Axora Relay made. Requests, tokens and images are exactly what providers reported. Providers don’t include prices in their responses, so any cost
          here is an estimate from rates you enter below.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl<Range>
          size="sm"
          value={range}
          onChange={setRange}
          options={[
            { value: 'today', label: 'Today' },
            { value: '7d', label: '7 days' },
            { value: '30d', label: '30 days' },
            { value: 'month', label: 'This month' },
            { value: 'custom', label: 'Custom' }
          ]}
        />
        {range === 'custom' && (
          <>
            <Input aria-label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} wrapperClassName="w-40" />
            <Input aria-label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} wrapperClassName="w-40" />
          </>
        )}
        <Select<string>
          size="sm"
          className="ml-auto w-48"
          aria-label="Provider"
          value={providerId}
          onChange={setProviderId}
          options={[{ value: 'all', label: 'All providers' }, ...aiProviders.map((p) => ({ value: p.id, label: p.name }))]}
        />
      </div>

      {!valid ? (
        <p className="text-sm text-danger">Choose a start date before the end date.</p>
      ) : !t ? (
        <Skeleton className="h-24" />
      ) : (
        <section aria-label="Totals" className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line @2xl:grid-cols-4">
          <Total label="Requests" value={formatNumber(t.requests)} detail={`${formatNumber(t.succeeded)} succeeded · ${formatNumber(t.failed)} failed`} />
          <Total label="Tokens" value={formatNumber(t.totalTokens)} detail={`${formatNumber(t.inputTokens)} in · ${formatNumber(t.outputTokens)} out`} />
          <Total label="Images" value={formatNumber(t.images)} detail="Generated" />
          <Total
            label="Estimated cost"
            value={money(t.estimatedCost)}
            detail={t.estimatedCost === null ? 'Add your rates to estimate' : t.unpriced ? `From your rates · ${formatNumber(t.unpriced)} not priced` : 'From your rates'}
          />
        </section>
      )}

      {report.data && (
        <section aria-label="Breakdown" className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-fg">Breakdown</h3>
            <SegmentedControl<Breakdown>
              size="sm"
              value={breakdown}
              onChange={setBreakdown}
              options={[
                { value: 'day', label: 'By day' },
                { value: 'month', label: 'By month' },
                { value: 'provider', label: 'By provider' },
                { value: 'type', label: 'By request type' }
              ]}
            />
          </div>
          {rows.length === 0 ? (
            <EmptyState size="sm" icon={Gauge} title="No requests in this period" />
          ) : (
            <table aria-label="Usage breakdown" className="w-full table-fixed text-sm">
              <thead>
                <tr className="text-left text-2xs uppercase tracking-[0.06em] text-fg-faint">
                  <th className="w-[30%] py-1.5 font-medium">{breakdown === 'provider' ? 'Provider' : breakdown === 'type' ? 'Request type' : breakdown === 'month' ? 'Month' : 'Day'}</th>
                  <th className="py-1.5 font-medium">Requests</th>
                  <th className="w-[16%] py-1.5 text-right font-medium">Tokens</th>
                  <th className="w-[10%] py-1.5 text-right font-medium">Images</th>
                  <th className="w-[14%] py-1.5 text-right font-medium">Est. cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className="border-t border-line">
                    <td className="truncate py-1.5 text-fg-muted">{r.label}</td>
                    <td className="py-1.5">
                      <span className="flex items-center gap-2">
                        <span className="h-1.5 rounded-full bg-accent/70" style={{ width: `${Math.max(4, (r.requests / max) * 60)}%` }} aria-hidden />
                        <span className="tabular text-xs text-fg-muted">
                          {formatNumber(r.requests)}
                          {r.failed ? <span className="text-danger"> · {formatNumber(r.failed)} failed</span> : null}
                        </span>
                      </span>
                    </td>
                    <td className="tabular py-1.5 text-right text-xs text-fg-muted">{formatNumber(r.totalTokens)}</td>
                    <td className="tabular py-1.5 text-right text-xs text-fg-muted">{formatNumber(r.images)}</td>
                    <td className="tabular py-1.5 text-right text-xs text-fg-muted">{money(r.estimatedCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      <RatesBlock providers={aiProviders} onChange={report.reload} />
      <LimitsBlock providers={aiProviders} />

      <section aria-label="Requests" className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-fg">Requests</h3>
        <AiUsagePanel providers={providers.data ?? []} />
      </section>
    </>
  )
}

function Total({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="flex flex-col gap-0.5 bg-surface-2 px-4 py-3">
      <span className="text-2xs font-medium uppercase tracking-[0.06em] text-fg-faint">{label}</span>
      <span className="tabular text-xl font-medium text-fg">{value}</span>
      <span className="text-xs text-fg-subtle">{detail}</span>
    </div>
  )
}

// ── rates ──────────────────────────────────────────────────────────────────

function RatesBlock({ providers, onChange }: { providers: ProviderConfig[]; onChange: () => void }) {
  const toast = useToast()
  const rates = useAsync(() => relay.usage.rates(), [])
  const [editing, setEditing] = useState<UsageRate | 'new' | null>(null)
  const [removing, setRemoving] = useState<UsageRate | null>(null)
  const list = rates.data ?? []
  return (
    <SettingsSection
      title="Your rates"
      description="What your provider charges, from your plan or invoice (USD). Used only to estimate costs above."
      meta={
        <Button size="sm" variant="ghost" icon={Plus} disabled={!providers.length} onClick={() => setEditing('new')}>
          Add rate
        </Button>
      }
    >
      {list.length === 0 ? (
        <p className="px-4 py-3 text-sm text-fg-subtle">No rates yet — costs are not estimated.</p>
      ) : (
        <ul className="flex flex-col">
          {list.map((r) => (
            <li key={r.id} className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm text-fg">
                  {r.providerName} <span className="text-fg-subtle">· {r.model ?? 'all models'}</span>
                </span>
                <span className="text-xs text-fg-subtle">
                  {[r.inputPerMillion !== null && `$${r.inputPerMillion} / 1M input tokens`, r.outputPerMillion !== null && `$${r.outputPerMillion} / 1M output tokens`, r.perImage !== null && `$${r.perImage} per image`]
                    .filter(Boolean)
                    .join(' · ')}
                  {r.note ? ` — ${r.note}` : ''}
                </span>
              </span>
              <IconButton icon={Pencil} label="Edit rate" size="sm" onClick={() => setEditing(r)} />
              <IconButton icon={Trash2} label="Delete rate" size="sm" onClick={() => setRemoving(r)} />
            </li>
          ))}
        </ul>
      )}
      <RateDialog
        open={editing !== null}
        rate={editing === 'new' ? null : editing}
        providers={providers}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null)
          rates.reload()
          onChange()
        }}
      />
      <ConfirmDialog
        open={Boolean(removing)}
        title="Delete this rate?"
        description="Costs for these requests will no longer be estimated."
        confirmLabel="Delete"
        tone="danger"
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          const r = removing
          setRemoving(null)
          if (!r) return
          try {
            await relay.usage.removeRate(r.id)
            rates.reload()
            onChange()
          } catch (error) {
            toast({ tone: 'danger', title: 'Not deleted', description: errorMessage(error) })
          }
        }}
      />
    </SettingsSection>
  )
}

function RateDialog({ open, rate, providers, onClose, onSaved }: { open: boolean; rate: UsageRate | null; providers: ProviderConfig[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast()
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [image, setImage] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!open) return
    setProviderId(rate?.providerId ?? providers[0]?.id ?? '')
    setModel(rate?.model ?? '')
    setInput(rate?.inputPerMillion?.toString() ?? '')
    setOutput(rate?.outputPerMillion?.toString() ?? '')
    setImage(rate?.perImage?.toString() ?? '')
    setNote(rate?.note ?? '')
  }, [open, rate, providers])
  const num = (v: string) => (v.trim() === '' ? null : Number(v))
  const bad = [input, output, image].some((v) => v.trim() !== '' && (!Number.isFinite(Number(v)) || Number(v) < 0))
  const empty = [input, output, image].every((v) => v.trim() === '')
  const save = async () => {
    setSaving(true)
    try {
      await relay.usage.saveRate({ ...(rate ? { id: rate.id } : {}), providerId, model: model.trim() || null, inputPerMillion: num(input), outputPerMillion: num(output), perImage: num(image), note })
      toast({ tone: 'success', title: 'Rate saved' })
      onSaved()
    } catch (error) {
      toast({ tone: 'danger', title: 'Not saved', description: errorMessage(error) })
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={rate ? 'Edit rate' : 'Add rate'}
      description="Enter the prices you pay. Leave a field empty if it doesn’t apply."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!providerId || bad || empty} onClick={save}>
            Save rate
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Provider" htmlFor="rate-provider">
            <Select<string> id="rate-provider" value={providerId} onChange={setProviderId} options={providers.map((p) => ({ value: p.id, label: p.name }))} />
          </Field>
          <Field label="Model" htmlFor="rate-model" aside={<span className="text-2xs text-fg-faint">Empty = all models</span>}>
            <Input id="rate-model" value={model} spellCheck={false} onChange={(e) => setModel(e.target.value)} className="font-mono text-xs" />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Input, per 1M tokens" htmlFor="rate-input">
            <Input id="rate-input" inputMode="decimal" value={input} onChange={(e) => setInput(e.target.value)} invalid={input.trim() !== '' && !(Number(input) >= 0)} />
          </Field>
          <Field label="Output, per 1M tokens" htmlFor="rate-output">
            <Input id="rate-output" inputMode="decimal" value={output} onChange={(e) => setOutput(e.target.value)} invalid={output.trim() !== '' && !(Number(output) >= 0)} />
          </Field>
          <Field label="Per image" htmlFor="rate-image">
            <Input id="rate-image" inputMode="decimal" value={image} onChange={(e) => setImage(e.target.value)} invalid={image.trim() !== '' && !(Number(image) >= 0)} />
          </Field>
        </div>
        <Field label="Note" htmlFor="rate-note" aside={<span className="text-2xs text-fg-faint">Optional</span>}>
          <Textarea id="rate-note" rows={2} maxLength={300} value={note} placeholder="Where these prices come from" onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

// ── limits ─────────────────────────────────────────────────────────────────

function LimitsBlock({ providers }: { providers: ProviderConfig[] }) {
  const toast = useToast()
  const limits = useAsync(() => relay.usage.limits(), [])
  useEffect(() => relay.integrations.onChange(limits.reload), [limits.reload])
  const [editing, setEditing] = useState<UsageLimit | 'new' | null>(null)
  const list = limits.data ?? []
  return (
    <SettingsSection
      title="Limits"
      description="Optional. Get a notice at 80% and 100%; a blocking limit also pauses new AI requests until the period ends."
      meta={
        <Button size="sm" variant="ghost" icon={Plus} onClick={() => setEditing('new')}>
          Add limit
        </Button>
      }
    >
      {list.length === 0 ? (
        <p className="px-4 py-3 text-sm text-fg-subtle">No limits.</p>
      ) : (
        <ul className="flex flex-col">
          {list.map((l) => (
            <li key={l.id} className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0">
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-sm text-fg">
                  {METRIC[l.metric]} per {l.period} · {l.providerName ?? 'all providers'}
                  <span className="text-fg-subtle"> · {l.action === 'block' ? 'blocks at 100%' : 'notice only'}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="h-1.5 w-40 overflow-hidden rounded-full bg-surface-4" aria-hidden>
                    <span className={cn('block h-full rounded-full', l.percent >= 100 ? 'bg-danger' : l.percent >= 80 ? 'bg-warning' : 'bg-accent')} style={{ width: `${Math.min(l.percent, 100)}%` }} />
                  </span>
                  <span className="tabular text-xs text-fg-subtle">
                    {l.metric === 'estimated-cost' ? `${money(l.current)} of ${money(l.threshold)}` : `${formatNumber(l.current)} of ${formatNumber(l.threshold)}`} ({l.percent}%)
                  </span>
                </span>
              </span>
              <IconButton icon={Pencil} label="Edit limit" size="sm" onClick={() => setEditing(l)} />
              <IconButton
                icon={Trash2}
                label="Delete limit"
                size="sm"
                onClick={async () => {
                  try {
                    await relay.usage.removeLimit(l.id)
                    limits.reload()
                  } catch (error) {
                    toast({ tone: 'danger', title: 'Not deleted', description: errorMessage(error) })
                  }
                }}
              />
            </li>
          ))}
        </ul>
      )}
      <LimitDialog
        open={editing !== null}
        limit={editing === 'new' ? null : editing}
        providers={providers}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null)
          limits.reload()
        }}
      />
    </SettingsSection>
  )
}

function LimitDialog({ open, limit, providers, onClose, onSaved }: { open: boolean; limit: UsageLimit | null; providers: ProviderConfig[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast()
  const [value, setValue] = useState<UsageLimitInput>({ providerId: null, period: 'month', metric: 'requests', threshold: 1000, action: 'warn' })
  const [threshold, setThreshold] = useState('1000')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!open) return
    const v = limit ?? { providerId: null, period: 'month' as const, metric: 'requests' as const, threshold: 1000, action: 'warn' as const }
    setValue({ providerId: v.providerId, period: v.period, metric: v.metric, threshold: v.threshold, action: v.action })
    setThreshold(String(v.threshold))
  }, [open, limit])
  const n = Number(threshold)
  const valid = Number.isFinite(n) && n > 0 && (value.metric === 'estimated-cost' || Number.isInteger(n))
  const options = useMemo(() => [{ value: 'all', label: 'All providers' }, ...providers.map((p) => ({ value: p.id, label: p.name }))], [providers])
  const save = async () => {
    setSaving(true)
    try {
      await relay.usage.saveLimit({ ...(limit ? { id: limit.id } : {}), ...value, threshold: n })
      toast({ tone: 'success', title: 'Limit saved' })
      onSaved()
    } catch (error) {
      toast({ tone: 'danger', title: 'Not saved', description: errorMessage(error) })
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={limit ? 'Edit limit' : 'Add limit'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!valid} onClick={save}>
            Save limit
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Provider" htmlFor="limit-provider">
          <Select<string> id="limit-provider" value={value.providerId ?? 'all'} onChange={(v) => setValue({ ...value, providerId: v === 'all' ? null : v })} options={options} />
        </Field>
        <Field label="Measure" htmlFor="limit-metric">
          <Select<UsageMetric> id="limit-metric" value={value.metric} onChange={(metric) => setValue({ ...value, metric })} options={(Object.keys(METRIC) as UsageMetric[]).map((m) => ({ value: m, label: METRIC[m] }))} />
        </Field>
        <Field label="Limit" htmlFor="limit-threshold" error={!valid ? (value.metric === 'estimated-cost' ? 'Enter an amount above 0.' : 'Enter a whole number above 0.') : null}>
          <Input id="limit-threshold" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} invalid={!valid} />
        </Field>
        <Field label="Per" htmlFor="limit-period">
          <SegmentedControl<'day' | 'month'> value={value.period} onChange={(period) => setValue({ ...value, period })} options={[{ value: 'day', label: 'Day' }, { value: 'month', label: 'Month' }]} />
        </Field>
        <Field label="When reached" htmlFor="limit-action">
          <SegmentedControl<'warn' | 'block'> value={value.action} onChange={(action) => setValue({ ...value, action })} options={[{ value: 'warn', label: 'Notify' }, { value: 'block', label: 'Notify and pause AI' }]} />
        </Field>
      </div>
    </Modal>
  )
}
