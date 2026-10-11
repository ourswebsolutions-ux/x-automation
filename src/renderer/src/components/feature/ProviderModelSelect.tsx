import { isLikelyImageModel } from '@shared/config/imageModels'
import { useEffect } from 'react'
import { AI_ADAPTERS } from '@shared/config/aiAdapters'
import type { ProviderConfig } from '@shared/types/providers'
import { Select } from '@/components/ui'
import { useCachedModels } from '@/data/ai'

export interface ProviderChoice {
  providerId: string | null
  model: string | null
}

interface ProviderModelSelectProps {
  providers: ProviderConfig[]
  value: ProviderChoice
  onChange: (choice: ProviderChoice) => void
  disabled?: boolean
  size?: 'sm' | 'md'
  /** Which of the provider's models to offer. */
  kind?: 'text' | 'image'
}

/**
 * Picks one of the enabled, complete AI text providers and one of its models
 * (from the provider's own list, or the model configured for it).
 */
export function ProviderModelSelect({ providers, value, onChange, disabled, size = 'sm', kind = 'text' }: ProviderModelSelectProps) {
  const provider = providers.find((p) => p.id === value.providerId) ?? null
  const models = useCachedModels(provider?.id ?? null)

  // Fall back to the first usable provider (the default sorts first).
  useEffect(() => {
    if (!provider && providers[0]) onChange({ providerId: providers[0].id, model: providers[0].model })
  }, [provider, providers, onChange])

  const options = [...new Set([...(provider?.model ? [provider.model] : []), ...(models.data?.models ?? []).filter((m) => (kind === 'image' ? isLikelyImageModel(m.id) : m.likelyText)).map((m) => m.id)])]

  return (
    <div className="flex min-w-0 gap-2">
      <Select<string>
        size={size}
        className="min-w-0 flex-1"
        aria-label="AI provider"
        disabled={disabled || providers.length === 0}
        value={provider?.id ?? null}
        placeholder="No provider"
        onChange={(id) => onChange({ providerId: id, model: providers.find((p) => p.id === id)?.model ?? null })}
        options={providers.map((p) => ({ value: p.id, label: p.name, description: AI_ADAPTERS[p.adapter ?? 'openai-chat'].label }))}
      />
      <Select<string>
        size={size}
        className="min-w-0 flex-1"
        aria-label="Model"
        disabled={disabled || !provider || options.length === 0}
        value={value.model ?? provider?.model ?? null}
        placeholder="Model"
        onChange={(model) => onChange({ providerId: value.providerId, model })}
        options={options.map((id) => ({ value: id, label: id }))}
      />
    </div>
  )
}
