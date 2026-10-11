import { Activity, RotateCw } from 'lucide-react'
import { DemoBadge, EmptyState, ErrorState, IconButton, LiveBadge, Panel, SkeletonRows, StatusDot } from '@/components/ui'
import type { useWorkspaceSummary } from '@/data/workspace'
import { formatRelative } from '@/lib/format'
import { ACTIVITY_TONE } from '@/lib/status'

type Summary = ReturnType<typeof useWorkspaceSummary>

export function ActivityPanel({ summary }: { summary: Summary }) {
  const events = summary.data?.recentActivity ?? []

  return (
    <Panel
      title="Recent activity"
      meta={summary.demo ? <DemoBadge /> : <LiveBadge />}
      actions={!summary.demo && <IconButton icon={RotateCw} label="Refresh" size="sm" onClick={summary.reload} />}
      padded={false}
    >
      {summary.status === 'error' ? (
        <ErrorState size="sm" title="Activity could not be loaded" error={summary.error} onRetry={summary.reload} />
      ) : !summary.data ? (
        <SkeletonRows rows={4} className="p-4" />
      ) : events.length === 0 ? (
        <EmptyState
          size="sm"
          icon={Activity}
          title="No activity yet"
          description="Drafts you create, profile syncs and publishing results will be recorded here."
        />
      ) : (
        <ol className="relative px-4 py-2">
          {events.map((event, index) => (
            <li key={event.id} className="relative flex gap-3 py-2">
              {index < events.length - 1 && (
                <span aria-hidden className="absolute left-[3px] top-[22px] h-[calc(100%-12px)] w-px bg-line" />
              )}
              <StatusDot tone={ACTIVITY_TONE[event.level]} className="mt-[7px]" />
              <div className="flex min-w-0 flex-1 items-baseline gap-2">
                <p className="min-w-0 flex-1 truncate text-sm text-fg">
                  {event.message}
                  {event.subject && <span className="text-fg-subtle"> · {event.subject}</span>}
                </p>
                <time dateTime={event.at} className="tabular shrink-0 text-xs text-fg-faint">
                  {formatRelative(event.at)}
                </time>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  )
}
