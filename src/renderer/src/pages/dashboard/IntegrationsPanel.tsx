import { ArrowRight, Bot, Globe, Image } from 'lucide-react'
import { useNavigate } from 'react-router'
import type { IntegrationId } from '@shared/types/integrations'
import { Button, ErrorState, LiveBadge, Panel, Skeleton, StatusBadge } from '@/components/ui'
import { INTEGRATION_STATE } from '@/lib/status'
import { useSystem } from '@/state/system'
import { settingsPath } from '@/app/navigation'

const ICONS: Partial<Record<IntegrationId, typeof Globe>> = { ixbrowser: Globe, 'text-ai': Bot, 'image-ai': Image }

export function IntegrationsPanel() {
  const { integrations } = useSystem()
  const navigate = useNavigate()
  const shown = integrations.data?.filter((item) => item.id in ICONS)

  return (
    <Panel
      title="Integrations"
      meta={<LiveBadge />}
      padded={false}
      footer={
        <Button size="sm" variant="ghost" trailingIcon={ArrowRight} className="-ml-2" onClick={() => navigate(settingsPath('ai'))}>
          Manage integrations
        </Button>
      }
    >
      {integrations.status === 'error' ? (
        <ErrorState size="sm" error={integrations.error} onRetry={integrations.reload} />
      ) : (
        <ul className="flex flex-col px-4 py-1.5">
          {shown
            ? shown.map((item) => {
                const Icon = ICONS[item.id] ?? Globe
                const meta = INTEGRATION_STATE[item.state]
                return (
                  <li key={item.id} className="flex items-center gap-3 border-b border-line py-2.5 last:border-0">
                    <Icon size={15} strokeWidth={1.7} className="shrink-0 text-fg-subtle" />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm text-fg">{item.name}</span>
                      <span className="truncate text-xs text-fg-subtle">
                        {item.state === 'planned' ? `Arrives in Phase ${item.phase}` : item.detail}
                      </span>
                    </div>
                    <StatusBadge tone={meta.tone} dot>
                      {meta.label}
                    </StatusBadge>
                  </li>
                )
              })
            : Array.from({ length: 3 }, (_, i) => (
                <li key={i} className="flex items-center gap-3 border-b border-line py-3 last:border-0">
                  <Skeleton className="size-4" />
                  <Skeleton className="h-2.5 flex-1" />
                  <Skeleton className="h-4 w-14" />
                </li>
              ))}
        </ul>
      )}
    </Panel>
  )
}
