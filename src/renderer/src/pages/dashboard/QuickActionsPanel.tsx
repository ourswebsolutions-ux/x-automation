import { ArrowRight, Blocks, Sparkles, SquarePen, SlidersHorizontal, type LucideIcon } from 'lucide-react'
import { useNavigate } from 'react-router'
import { Panel } from '@/components/ui'
import { settingsPath } from '@/app/navigation'

interface QuickAction {
  label: string
  description: string
  icon: LucideIcon
  to: string
  primary?: boolean
}

const ACTIONS: QuickAction[] = [
  { label: 'Create a draft', description: 'Write a post by hand', icon: SquarePen, to: '/posts?compose=1', primary: true },
  { label: 'AI generator', description: 'Generate post variations', icon: Sparkles, to: '/generator' },
  { label: 'AI providers & keys', description: 'Text and image providers', icon: Blocks, to: settingsPath('ai') },
  { label: 'Open settings', description: 'Theme, start page, demo data', icon: SlidersHorizontal, to: settingsPath('general') }
]

export function QuickActionsPanel() {
  const navigate = useNavigate()
  return (
    <Panel title="Quick actions" padded={false}>
      <ul className="flex flex-col p-1.5">
        {ACTIONS.map(({ label, description, icon: Icon, to, primary }) => (
          <li key={label}>
            <button
              type="button"
              onClick={() => navigate(to)}
              className="group flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-neutral-soft focus-ring"
            >
              <span
                className={
                  primary
                    ? 'grid size-8 shrink-0 place-items-center rounded-md border border-accent-line/50 bg-accent-soft text-accent-text'
                    : 'grid size-8 shrink-0 place-items-center rounded-md border border-line-strong bg-surface-3 text-fg-muted'
                }
              >
                <Icon size={15} strokeWidth={1.8} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm text-fg">{label}</span>
                <span className="truncate text-xs text-fg-subtle">{description}</span>
              </span>
              <ArrowRight
                size={14}
                strokeWidth={1.8}
                className="-translate-x-1 text-fg-faint opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100"
              />
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  )
}
