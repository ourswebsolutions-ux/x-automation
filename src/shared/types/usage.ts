import type { AiOperation } from '../config/aiAdapters'
import type { Id, Timestamp } from './domain'

export interface UsageQuery {
  /** Inclusive ISO bounds. */
  from: Timestamp
  to: Timestamp
  providerId?: Id
  operation?: AiOperation
}

interface UsageNumbers {
  requests: number
  succeeded: number
  failed: number
  cancelled: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  images: number
  /**
   * Estimated cost from the rates you entered (USD). null when no rate applies
   * to any of the requests. Providers do not report costs in their responses.
   */
  estimatedCost: number | null
}

export interface UsageTotals extends UsageNumbers {
  /** Successful requests whose response included token usage. */
  withReportedUsage: number
  /** Successful requests that could be priced with your rates. */
  priced: number
  /** Successful requests that could not be priced (no rate, or no usage reported). */
  unpriced: number
}

export interface UsageRow extends UsageNumbers {
  key: string
  label: string
}

export interface UsageReport {
  query: UsageQuery
  totals: UsageTotals
  byDay: UsageRow[]
  byMonth: UsageRow[]
  byProvider: UsageRow[]
  byOperation: UsageRow[]
}

/** Prices you enter, per provider (optionally per model), in USD. */
export interface UsageRate {
  id: Id
  providerId: Id
  providerName: string
  /** null = all models of the provider without their own rate. */
  model: string | null
  inputPerMillion: number | null
  outputPerMillion: number | null
  perImage: number | null
  note: string
  updatedAt: Timestamp
}

export type UsageRateInput = Omit<UsageRate, 'id' | 'providerName' | 'updatedAt'> & { id?: Id }

export type UsageMetric = 'requests' | 'tokens' | 'images' | 'estimated-cost'

export interface UsageLimit {
  id: Id
  /** null = all providers together. */
  providerId: Id | null
  providerName: string | null
  period: 'day' | 'month'
  metric: UsageMetric
  threshold: number
  /** warn: notify at 80% and 100% · block: also refuse new AI requests at 100%. */
  action: 'warn' | 'block'
  /** Usage in the current period. */
  current: number
  percent: number
}

export type UsageLimitInput = Pick<UsageLimit, 'providerId' | 'period' | 'metric' | 'threshold' | 'action'> & { id?: Id }
