import { cn } from '@/lib/cn'
import type { PostLength } from '@/lib/postLength'

const R = 9
const CIRCUMFERENCE = 2 * Math.PI * R

/** Circular progress toward the post length limit; shows the count near the end. */
export function LengthMeter({ length }: { length: PostLength }) {
  const near = length.remaining <= 20
  const color = length.isOver ? 'var(--danger)' : near ? 'var(--warning)' : 'var(--accent)'
  return (
    <div className="flex items-center gap-2" aria-live="polite">
      <span className={cn('tabular text-xs', length.isOver ? 'text-danger' : near ? 'text-warning' : 'text-fg-subtle')}>
        {near ? length.remaining : `${length.weighted} / ${length.weighted + length.remaining}`}
      </span>
      <svg width="22" height="22" viewBox="0 0 22 22" className={cn('-rotate-90 transition-transform', near && 'scale-110')} aria-hidden>
        <circle cx="11" cy="11" r={R} fill="none" stroke="var(--line-strong)" strokeWidth="2" />
        <circle
          cx="11"
          cy="11"
          r={R}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - length.ratio)}
          className="transition-[stroke-dashoffset,stroke] duration-200"
        />
      </svg>
    </div>
  )
}
