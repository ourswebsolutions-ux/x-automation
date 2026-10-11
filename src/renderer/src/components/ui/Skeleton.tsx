import { cn } from '@/lib/cn'

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        'rounded-xs bg-[linear-gradient(90deg,var(--surface-3)_0%,var(--surface-4)_50%,var(--surface-3)_100%)]',
        'bg-[length:200%_100%] animate-shimmer',
        className
      )}
    />
  )
}

/** Generic stacked-rows placeholder used while lists load. */
export function SkeletonRows({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div role="status" aria-label="Loading" className={cn('flex flex-col gap-3', className)}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3">
          <Skeleton className="size-7 rounded-md" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className={cn('h-2.5', index % 2 ? 'w-3/5' : 'w-4/5')} />
            <Skeleton className="h-2 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  )
}
