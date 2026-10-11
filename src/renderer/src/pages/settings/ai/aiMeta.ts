import type { AiOperation } from '@shared/config/aiAdapters'
import type { AiConnectionTest, AiErrorKind, AiRequestStatus } from '@shared/types/ai'
import type { ProviderConfig } from '@shared/types/providers'
import type { Tone } from '@/components/ui'

export const ERROR_KIND: Record<AiErrorKind, string> = {
  'not-configured': 'Not configured',
  'blocked-endpoint': 'Endpoint blocked',
  auth: 'Key rejected',
  quota: 'Quota exhausted',
  'rate-limit': 'Rate limited',
  'usage-limit': 'Usage limit reached',
  model: 'Model unavailable',
  'invalid-request': 'Request rejected',
  timeout: 'Timed out',
  network: 'Network error',
  server: 'Provider error',
  malformed: 'Unexpected response',
  cancelled: 'Cancelled'
}

export const OPERATION: Record<AiOperation, string> = {
  'connection-test': 'Connection test',
  'list-models': 'Model list',
  'generate-text': 'Text generation',
  'generate-image': 'Image generation'
}

export const REQUEST_STATUS: Record<AiRequestStatus, { label: string; tone: Tone }> = {
  succeeded: { label: 'Succeeded', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' }
}

/** Connection status for a provider row: only "Connected" after a real successful request. */
export function connectionState(provider: ProviderConfig, test: AiConnectionTest | undefined): { label: string; tone: Tone; detail: string | null } {
  if (!provider.enabled) return { label: 'Disabled', tone: 'neutral', detail: null }
  if (provider.readiness.state === 'incomplete') return { label: 'Incomplete', tone: 'warning', detail: provider.readiness.issues.join(' ') }
  if (!test) return { label: 'Not tested', tone: 'info', detail: 'Settings are complete. Run a connection test to check the key and endpoint.' }
  if (!test.ok) return { label: ERROR_KIND[test.error?.kind ?? 'network'], tone: 'danger', detail: test.error ? `${test.error.message} ${test.error.hint}` : null }
  if (test.modelListed === false) return { label: 'Connected', tone: 'warning', detail: `The key works, but “${provider.model}” is not in the provider’s model list.` }
  return { label: 'Connected', tone: 'success', detail: null }
}
