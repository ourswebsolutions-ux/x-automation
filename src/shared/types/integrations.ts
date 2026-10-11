export type IntegrationId = 'ixbrowser' | 'text-ai' | 'image-ai' | 'database' | 'credentials'

/**
 * Honest connection states. Nothing is reported as `connected` unless a real
 * round-trip to the service has succeeded.
 */
export type IntegrationState =
  | 'planned' // not built yet — arrives in a later phase
  | 'not-configured' // built, but required settings are missing
  | 'configured' // settings present, connection not verified
  | 'connected' // verified by a real request
  | 'degraded'
  | 'error'
  | 'available' // local capability that is ready to use

export interface IntegrationStatus {
  id: IntegrationId
  name: string
  state: IntegrationState
  detail: string
  /** Delivery phase in which the integration becomes functional. */
  phase: number
}
