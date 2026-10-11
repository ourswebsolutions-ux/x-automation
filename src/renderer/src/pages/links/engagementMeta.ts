import { Bookmark, CalendarCheck, Heart, ListTodo, MessageSquareReply, Quote, Repeat2, type LucideIcon } from 'lucide-react'
import type { EngagementKind } from '@shared/types/links'

export const ENGAGEMENT_KIND: Record<EngagementKind, { label: string; icon: LucideIcon }> = {
  reply: { label: 'Reply', icon: MessageSquareReply },
  like: { label: 'Like', icon: Heart },
  repost: { label: 'Repost', icon: Repeat2 },
  quote: { label: 'Quote', icon: Quote },
  bookmark: { label: 'Bookmark', icon: Bookmark },
  'follow-up': { label: 'Follow up', icon: CalendarCheck },
  other: { label: 'Other', icon: ListTodo }
}
