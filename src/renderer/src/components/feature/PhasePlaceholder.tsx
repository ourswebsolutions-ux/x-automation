import { CircleDashed, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { IntegrationId } from '@shared/types/integrations'
import { PageHeader, PhaseBadge, StatusBadge } from '@/components/ui'
import { cn } from '@/lib/cn'
import { INTEGRATION_STATE } from '@/lib/status'
import { useSystem } from '@/state/system'
import { Wireframe, type WireframeKind } from './Wireframe'

interface PhasePlaceholderProps {
  title: string
  description: string
  phase: number
  icon: LucideIcon
  headline: string
  summary: ReactNode
  capabilities: string[]
  dependsOn?: IntegrationId[]
  wireframe: WireframeKind
  actions?: ReactNode
  headerActions?: ReactNode
}

/**
 * Honest placeholder for sections that land in a later phase: explains what
 * is coming, shows the real state of its prerequisites, and sketches the
 * planned layout as a wireframe.
 */
export function PhasePlaceholder({
  title,
  description,
  phase,
  icon: Icon,
  headline,
  summary,
  capabilities,
  dependsOn = [],
  wireframe,
  actions,
  headerActions
}: PhasePlaceholderProps) {
  const { integrations } = useSystem()
  const prerequisites = dependsOn
    .map((id) => integrations.data?.find((item) => item.id === id))
    .filter((item) => item !== undefined)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={title} description={description} meta={<PhaseBadge phase={phase} />} actions={headerActions} />

      <section className="grid overflow-hidden rounded-lg border border-line bg-surface-2 @4xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="flex flex-col gap-6 p-6 @4xl:p-8">
          <div className="flex flex-col gap-4">
            <span className="grid size-10 place-items-center rounded-lg border border-line-strong bg-surface-3 text-fg-muted shadow-raised">
              <Icon size={18} strokeWidth={1.6} />
            </span>
            <div className="flex flex-col gap-1.5">
              <h2 className="text-lg font-semibold tracking-[-0.01em] text-fg">{headline}</h2>
              <p className="max-w-md text-sm text-fg-muted text-pretty">{summary}</p>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-2xs font-medium uppercase tracking-[0.07em] text-fg-faint">Planned capabilities</h3>
            <ul className="flex flex-col gap-1.5">
              {capabilities.map((capability) => (
                <li key={capability} className="flex items-start gap-2.5 text-sm text-fg-muted">
                  <CircleDashed size={14} strokeWidth={1.7} className="mt-[3px] shrink-0 text-fg-faint" />
                  {capability}
                </li>
              ))}
            </ul>
          </div>

          {prerequisites.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="text-2xs font-medium uppercase tracking-[0.07em] text-fg-faint">Depends on</h3>
              <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
                {prerequisites.map((item) => {
                  const meta = INTEGRATION_STATE[item.state]
                  return (
                    <li key={item.id} className="flex items-center justify-between gap-3 px-3 py-2">
                      <span className="text-sm text-fg">{item.name}</span>
                      <StatusBadge tone={meta.tone} dot>
                        {meta.label}
                      </StatusBadge>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {actions && <div className="mt-auto flex flex-wrap gap-2 pt-2">{actions}</div>}
        </div>

        <div
          className={cn(
            'relative hidden border-l border-line bg-surface-1 p-6 @4xl:block',
            'bg-[radial-gradient(var(--line)_1px,transparent_1px)] bg-[length:16px_16px]'
          )}
          aria-hidden
        >
          <span className="absolute right-4 top-4 text-2xs font-medium uppercase tracking-[0.07em] text-fg-faint">Planned layout</span>
          <Wireframe kind={wireframe} />
        </div>
      </section>
    </div>
  )
}
