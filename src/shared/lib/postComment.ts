import { LENGTH_PROFILES } from '@shared/config/postLimits'
import { measurePost } from '@shared/lib/postLength'
import type { PostComment } from '@shared/types/domain'

export const NO_COMMENT: PostComment = { enabled: false, text: '' }

export interface CommentProblem {
  code: 'comment-empty' | 'comment-too-long' | 'comment-length'
  message: string
  /** False = a warning the user can accept. */
  blocking: boolean
}

/**
 * The rules for a comment saved with a post (checked in the editor, when saving and before
 * publishing). It is posted as a reply, so it follows the post length rules: up to 280 weighted
 * characters for every account, longer only with X Premium.
 */
export function commentProblems(comment: PostComment): CommentProblem[] {
  if (!comment.enabled) return []
  const text = comment.text.trim()
  if (!text) return [{ code: 'comment-empty', message: 'The comment is turned on but empty. Write it, or turn the comment off.', blocking: true }]
  const length = measurePost(text, LENGTH_PROFILES.standard.maxWeighted)
  if (length.weighted > LENGTH_PROFILES.premium.maxWeighted) {
    return [{ code: 'comment-too-long', message: `The comment is longer than X allows (${LENGTH_PROFILES.premium.maxWeighted.toLocaleString()} characters).`, blocking: true }]
  }
  if (length.isOver) return [{ code: 'comment-length', message: 'The comment is longer than 280 characters. Only accounts with X Premium can post it.', blocking: false }]
  return []
}
