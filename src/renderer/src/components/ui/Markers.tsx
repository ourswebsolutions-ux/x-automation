import { FlaskConical, Radio } from 'lucide-react'
import { StatusBadge } from './StatusBadge'
import { Tooltip } from './Tooltip'

/** Marks UI populated from the built-in sample dataset. */
export function DemoBadge() {
  return (
    <Tooltip content="Sample data for previewing the interface — not your accounts">
      <StatusBadge tone="warning" icon={FlaskConical}>
        Demo data
      </StatusBadge>
    </Tooltip>
  )
}

/** Marks UI that reflects the real state of this installation. */
export function LiveBadge() {
  return (
    <Tooltip content="Reflects the real state of this installation">
      <StatusBadge tone="neutral" icon={Radio}>
        Live
      </StatusBadge>
    </Tooltip>
  )
}

export function PhaseBadge({ phase }: { phase: number }) {
  return <StatusBadge variant="outline">Phase {phase}</StatusBadge>
}
