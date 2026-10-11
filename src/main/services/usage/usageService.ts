import { randomUUID } from 'node:crypto'
import type { AiOperation } from '@shared/config/aiAdapters'
import type { Id } from '@shared/types/domain'
import type { UsageLimit, UsageLimitInput, UsageMetric, UsageQuery, UsageRate, UsageRateInput, UsageReport, UsageRow, UsageTotals } from '@shared/types/usage'
import type { SqliteDatabase } from '../database/driver'
import { NotFoundError, ValidationError } from '../errors'
import type { ScopedLogger } from '../logging/logger'
import type { Notifier } from '../notifications/notifier'

interface Deps {
  db: SqliteDatabase
  notifier: Notifier
  log: ScopedLogger
  onChange: () => void
  now?: () => Date
}

interface UsageRowDb {
  provider_id: string | null
  provider_name: string
  model: string | null
  operation: AiOperation
  status: 'succeeded' | 'failed' | 'cancelled'
  started_at: string
  input_tokens: number | null
  output_tokens: number | null
  total_tokens: number | null
  usage_reported: number
  image_count: number | null
}

const OPERATION_LABEL: Record<AiOperation, string> = {
  'connection-test': 'Connection tests',
  'list-models': 'Model lists',
  'generate-text': 'Text generation',
  'generate-image': 'Image generation'
}

const pad = (n: number) => String(n).padStart(2, '0')
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const localMonth = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
const MAX_ROWS = 200_000

const blank = (): Omit<UsageRow, 'key' | 'label'> => ({ requests: 0, succeeded: 0, failed: 0, cancelled: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, images: 0, estimatedCost: null })

/**
 * Usage and cost tracking over the recorded AI requests (ai_usage). Counts
 * and tokens are exactly what providers reported — nothing is inferred. Costs
 * are estimates from rates the user entered, never presented as actual
 * charges: the providers' responses carry no price.
 */
export class UsageService {
  constructor(private readonly deps: Deps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  report(query: UsageQuery): UsageReport {
    if (Number.isNaN(Date.parse(query.from)) || Number.isNaN(Date.parse(query.to)) || query.from > query.to) throw new ValidationError('Choose a valid date range.')
    const where = ['started_at >= :from', 'started_at <= :to']
    const params: Record<string, string | number> = { from: query.from, to: query.to, limit: MAX_ROWS }
    if (query.providerId) {
      where.push('provider_id = :providerId')
      params.providerId = query.providerId
    }
    if (query.operation) {
      where.push('operation = :operation')
      params.operation = query.operation
    }
    const rows = this.deps.db.all<UsageRowDb>(
      `SELECT provider_id, provider_name, model, operation, status, started_at, input_tokens, output_tokens, total_tokens, usage_reported, image_count
       FROM ai_usage WHERE ${where.join(' AND ')} ORDER BY started_at LIMIT :limit`,
      params
    )
    const rates = this.listRates()
    const totals: UsageTotals = { ...blank(), withReportedUsage: 0, priced: 0, unpriced: 0 }
    const groups = { day: new Map<string, UsageRow>(), month: new Map<string, UsageRow>(), provider: new Map<string, UsageRow>(), operation: new Map<string, UsageRow>() }
    const bump = (map: Map<string, UsageRow>, key: string, label: string, row: UsageRowDb, cost: number | null) => {
      const entry = map.get(key) ?? { key, label, ...blank() }
      this.add(entry, row, cost)
      map.set(key, entry)
    }
    for (const row of rows) {
      const cost = row.status === 'succeeded' ? this.costOf(row, rates) : null
      this.add(totals, row, cost)
      if (row.status === 'succeeded') {
        if (row.usage_reported) totals.withReportedUsage++
        if (cost === null) totals.unpriced++
        else totals.priced++
      }
      const at = new Date(row.started_at)
      bump(groups.day, localDay(at), localDay(at), row, cost)
      bump(groups.month, localMonth(at), localMonth(at), row, cost)
      bump(groups.provider, row.provider_id ?? `name:${row.provider_name}`, row.provider_name, row, cost)
      bump(groups.operation, row.operation, OPERATION_LABEL[row.operation] ?? row.operation, row, cost)
    }
    const byKey = (map: Map<string, UsageRow>) => [...map.values()].sort((a, b) => a.key.localeCompare(b.key))
    return {
      query,
      totals,
      byDay: byKey(groups.day),
      byMonth: byKey(groups.month),
      byProvider: [...groups.provider.values()].sort((a, b) => b.requests - a.requests),
      byOperation: [...groups.operation.values()].sort((a, b) => b.requests - a.requests)
    }
  }

  // ── rates ────────────────────────────────────────────────────────────────

  listRates(): UsageRate[] {
    return this.deps.db
      .all<Record<string, unknown>>(
        `SELECT r.*, p.name AS provider_name FROM usage_rates r JOIN provider_configs p ON p.id = r.provider_id ORDER BY p.name COLLATE NOCASE, COALESCE(r.model, '')`
      )
      .map((r) => ({
        id: String(r.id),
        providerId: String(r.provider_id),
        providerName: String(r.provider_name),
        model: r.model === null ? null : String(r.model),
        inputPerMillion: r.input_per_million === null ? null : Number(r.input_per_million),
        outputPerMillion: r.output_per_million === null ? null : Number(r.output_per_million),
        perImage: r.per_image === null ? null : Number(r.per_image),
        note: String(r.note ?? ''),
        updatedAt: String(r.updated_at)
      }))
  }

  saveRate(input: UsageRateInput): UsageRate {
    if (!this.deps.db.get('SELECT 1 AS x FROM provider_configs WHERE id = :id', { id: input.providerId })) throw new ValidationError('That provider no longer exists.')
    const model = input.model?.trim() || null
    if (model && model.length > 120) throw new ValidationError('That model name is too long.')
    for (const value of [input.inputPerMillion, input.outputPerMillion, input.perImage]) {
      if (value !== null && (!Number.isFinite(value) || value < 0 || value > 100_000)) throw new ValidationError('Rates must be between 0 and 100,000.')
    }
    if (input.inputPerMillion === null && input.outputPerMillion === null && input.perImage === null) throw new ValidationError('Enter at least one rate.')
    const note = input.note.trim().slice(0, 300)
    const now = this.now().toISOString()
    const clash = this.deps.db.get<{ id: string }>("SELECT id FROM usage_rates WHERE provider_id = :providerId AND COALESCE(model, '') = :model", { providerId: input.providerId, model: model ?? '' })
    const id = input.id ?? clash?.id ?? randomUUID()
    if (clash && clash.id !== id) throw new ValidationError('There is already a rate for that model. Edit it instead.')
    this.deps.db.run(
      `INSERT INTO usage_rates (id, provider_id, model, input_per_million, output_per_million, per_image, note, updated_at)
       VALUES (:id, :providerId, :model, :input, :output, :image, :note, :now)
       ON CONFLICT(id) DO UPDATE SET provider_id = excluded.provider_id, model = excluded.model, input_per_million = excluded.input_per_million,
         output_per_million = excluded.output_per_million, per_image = excluded.per_image, note = excluded.note, updated_at = excluded.updated_at`,
      { id, providerId: input.providerId, model, input: input.inputPerMillion, output: input.outputPerMillion, image: input.perImage, note, now }
    )
    this.deps.onChange()
    return this.listRates().find((r) => r.id === id)!
  }

  removeRate(id: Id): void {
    if (!this.deps.db.run('DELETE FROM usage_rates WHERE id = :id', { id }).changes) throw new NotFoundError('That rate no longer exists.')
    this.deps.onChange()
  }

  // ── limits ───────────────────────────────────────────────────────────────

  listLimits(): UsageLimit[] {
    return this.deps.db
      .all<Record<string, unknown>>(
        `SELECT l.*, p.name AS provider_name FROM usage_limits l LEFT JOIN provider_configs p ON p.id = l.provider_id ORDER BY l.created_at`
      )
      .map((r) => {
        const limit = {
          id: String(r.id),
          providerId: r.provider_id === null ? null : String(r.provider_id),
          providerName: r.provider_name === null || r.provider_name === undefined ? null : String(r.provider_name),
          period: r.period as UsageLimit['period'],
          metric: r.metric as UsageMetric,
          threshold: Number(r.threshold),
          action: r.action as UsageLimit['action']
        }
        const current = this.currentValue(limit.providerId, limit.period, limit.metric)
        return { ...limit, current, percent: Math.round((current / limit.threshold) * 100) }
      })
  }

  saveLimit(input: UsageLimitInput): UsageLimit {
    if (input.providerId && !this.deps.db.get('SELECT 1 AS x FROM provider_configs WHERE id = :id', { id: input.providerId })) throw new ValidationError('That provider no longer exists.')
    if (!Number.isFinite(input.threshold) || input.threshold <= 0 || input.threshold > 1e12) throw new ValidationError('Enter a limit above zero.')
    if (input.metric !== 'estimated-cost' && !Number.isInteger(input.threshold)) throw new ValidationError('Use a whole number for this limit.')
    const now = this.now().toISOString()
    const id = input.id ?? randomUUID()
    this.deps.db.run(
      `INSERT INTO usage_limits (id, provider_id, period, metric, threshold, action, warned_period, created_at, updated_at)
       VALUES (:id, :providerId, :period, :metric, :threshold, :action, NULL, :now, :now)
       ON CONFLICT(id) DO UPDATE SET provider_id = excluded.provider_id, period = excluded.period, metric = excluded.metric,
         threshold = excluded.threshold, action = excluded.action, warned_period = NULL, updated_at = excluded.updated_at`,
      { id, providerId: input.providerId, period: input.period, metric: input.metric, threshold: input.threshold, action: input.action, now }
    )
    this.deps.onChange()
    return this.listLimits().find((l) => l.id === id)!
  }

  removeLimit(id: Id): void {
    if (!this.deps.db.run('DELETE FROM usage_limits WHERE id = :id', { id }).changes) throw new NotFoundError('That limit no longer exists.')
    this.deps.onChange()
  }

  /** Called before an AI request: the reason it must not run, or null. */
  blockedReason(providerId: Id): string | null {
    for (const limit of this.listLimits()) {
      if (limit.action !== 'block' || (limit.providerId && limit.providerId !== providerId)) continue
      if (limit.current >= limit.threshold) {
        const scope = limit.providerName ?? 'all AI providers'
        return `The ${limit.period === 'day' ? 'daily' : 'monthly'} usage limit for ${scope} has been reached. Change it in Settings → Usage & costs.`
      }
    }
    return null
  }

  /** Called after each recorded request: notifies once per period at 80% and at 100%. */
  evaluate(providerId: Id): void {
    try {
      for (const limit of this.listLimits()) {
        if (limit.providerId && limit.providerId !== providerId) continue
        const level = limit.current >= limit.threshold ? 100 : limit.percent >= 80 ? 80 : 0
        if (!level) continue
        const mark = `${this.periodKey(limit.period)}:${level}`
        const warned = this.deps.db.get<{ warned_period: string | null }>('SELECT warned_period FROM usage_limits WHERE id = :id', { id: limit.id })?.warned_period
        if (warned === mark || (level === 80 && warned === `${this.periodKey(limit.period)}:100`)) continue
        this.deps.db.run('UPDATE usage_limits SET warned_period = :mark WHERE id = :id', { id: limit.id, mark })
        const scope = limit.providerName ?? 'all AI providers'
        const what = `${limit.period === 'day' ? 'Daily' : 'Monthly'} ${limit.metric === 'estimated-cost' ? 'estimated cost' : limit.metric} for ${scope}`
        this.deps.notifier.notify({
          tone: level === 100 ? 'danger' : 'warning',
          event: 'systemNotices',
          title: level === 100 ? 'Usage limit reached' : 'Usage limit almost reached',
          body: `${what}: ${level}% of your limit.${level === 100 && limit.action === 'block' ? ' New AI requests are paused until the limit resets or you change it.' : ''}`,
          to: '/settings?section=usage'
        })
      }
    } catch (error) {
      this.deps.log.error('Could not check usage limits', error)
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private add(target: Omit<UsageRow, 'key' | 'label'>, row: UsageRowDb, cost: number | null): void {
    target.requests++
    target[row.status]++
    if (row.status === 'succeeded') {
      target.inputTokens += row.input_tokens ?? 0
      target.outputTokens += row.output_tokens ?? 0
      target.totalTokens += row.total_tokens ?? (row.input_tokens ?? 0) + (row.output_tokens ?? 0)
      target.images += row.image_count ?? 0
    }
    if (cost !== null) target.estimatedCost = (target.estimatedCost ?? 0) + cost
  }

  /** Estimated cost of one successful request from the user's rates, or null when it can't be priced. */
  private costOf(row: UsageRowDb, rates: UsageRate[]): number | null {
    if (!row.provider_id) return null
    const rate = rates.find((r) => r.providerId === row.provider_id && r.model !== null && r.model === row.model) ?? rates.find((r) => r.providerId === row.provider_id && r.model === null)
    if (!rate) return null
    let cost = 0
    let priced = false
    if (row.image_count && rate.perImage !== null) {
      cost += row.image_count * rate.perImage
      priced = true
    }
    if (row.usage_reported && (rate.inputPerMillion !== null || rate.outputPerMillion !== null)) {
      cost += ((row.input_tokens ?? 0) / 1e6) * (rate.inputPerMillion ?? 0) + ((row.output_tokens ?? 0) / 1e6) * (rate.outputPerMillion ?? 0)
      priced = true
    }
    return priced ? cost : null
  }

  private periodKey(period: 'day' | 'month'): string {
    return period === 'day' ? localDay(this.now()) : localMonth(this.now())
  }

  private currentValue(providerId: Id | null, period: 'day' | 'month', metric: UsageMetric): number {
    const now = this.now()
    const start = period === 'day' ? new Date(now.getFullYear(), now.getMonth(), now.getDate()) : new Date(now.getFullYear(), now.getMonth(), 1)
    const report = this.report({ from: start.toISOString(), to: now.toISOString(), ...(providerId ? { providerId } : {}) })
    const t = report.totals
    switch (metric) {
      case 'requests':
        return t.requests - t.cancelled
      case 'tokens':
        return t.totalTokens
      case 'images':
        return t.images
      case 'estimated-cost':
        return Math.round((t.estimatedCost ?? 0) * 100) / 100
    }
  }
}
