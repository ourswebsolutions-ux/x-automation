/**
 * IX Browser Local API V2 — wire-level contract, verified against the
 * official client (github.com/ixspyinc/ixbrowser-local-api-python, "ixBrowser
 * Local API V2.0"):
 *
 *   POST http://127.0.0.1:53200/api/v2/<action>   (JSON body, no auth;
 *   the Local API must be enabled in the IX Browser desktop client)
 *
 *   Envelope: { "error": { "code": int, "message"?: string }, "data"?: any }
 *   code 0 = success. Paginated data: { "total": int, "data": [...] }.
 *
 * Only the actions listed in IX_ACTIONS are used. Cookie, password and
 * fingerprint actions exist in the API but are deliberately never called.
 */
export const IX_API_PATH = '/api/v2/'

export const IX_ACTIONS = {
  profileList: 'profile-list',
  openedByApi: 'profile-opened-list',
  openedByClient: 'native-client-profile-opened-list',
  open: 'profile-open',
  close: 'profile-close',
  /** Documented as update_profile_to_custom_proxy_mode() in the official SDK. */
  updateCustomProxy: 'profile-update-proxy-for-custom-proxy'
} as const

export type IxAction = (typeof IX_ACTIONS)[keyof typeof IX_ACTIONS]

/** A profile as returned by profile-list, after validation and sanitising. */
export interface IxProfileRecord {
  profileId: number
  name: string
  siteUrl: string | null
  /** Other primitive, non-sensitive fields from the response. */
  extra: Record<string, string | number | boolean>
}

export interface IxProfilePage {
  total: number
  items: IxProfileRecord[]
}

export interface IxOpenResult {
  /** Present in the documented response; kept in the main process only. */
  debuggingAddress: string | null
}
