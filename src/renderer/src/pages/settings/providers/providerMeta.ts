import { Bot, Globe, Image, type LucideIcon } from 'lucide-react'
import type { ProviderKind, ProviderReadinessState } from '@shared/types/providers'
import type { Tone } from '@/components/ui'

export const KIND_ICON: Record<ProviderKind, LucideIcon> = {
  ixbrowser: Globe,
  'openai-compatible': Bot,
  image: Image
}

export const READINESS: Record<ProviderReadinessState, { tone: Tone; label: string }> = {
  ready: { tone: 'info', label: 'Ready for testing' },
  incomplete: { tone: 'warning', label: 'Incomplete' },
  disabled: { tone: 'neutral', label: 'Disabled' }
}
