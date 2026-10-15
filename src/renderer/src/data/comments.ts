import { useAsync } from '@/hooks/useAsync'
import { relay } from '@/lib/bridge'

/** Saved comments for campaigns (bulk comments). */
export function useComments() {
  return useAsync(() => relay.comments.list(), [])
}
