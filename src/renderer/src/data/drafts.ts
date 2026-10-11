import { useEffect } from 'react'
import { LENGTH_PROFILES } from '@shared/config/postLimits'
import { useAsync } from '@/hooks/useAsync'
import { relay } from '@/lib/bridge'
import { usePreferences } from '@/state/preferences'

/** Drafts; reloads when publishing changes a draft's status (scheduled, published, failed). */
export function useDrafts() {
  const state = useAsync(() => relay.drafts.list(), [])
  const { reload } = state
  useEffect(() => relay.publishing.onChange(reload), [reload])
  return state
}

/** The length profile chosen in the editor (persisted in preferences). */
export function useLengthProfile() {
  const { preferences, update } = usePreferences()
  const id = preferences.editor.lengthProfile
  return { profile: LENGTH_PROFILES[id], setProfile: (next: typeof id) => update({ editor: { lengthProfile: next } }) }
}
