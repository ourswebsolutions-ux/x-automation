import { cn } from '@/lib/cn'

export type WireframeKind = 'composer' | 'calendar' | 'list'

const block = 'rounded-sm border border-dashed border-line-heavy bg-surface-2/60'
const bar = 'h-2 rounded-full bg-line-strong'

/** Static sketches of a planned screen. Decorative only. */
export function Wireframe({ kind }: { kind: WireframeKind }) {
  if (kind === 'calendar') {
    return (
      <div className="flex h-full flex-col gap-3 pt-6">
        <div className="flex items-center gap-2">
          <span className={cn(bar, 'w-24')} />
          <span className="flex-1" />
          <span className={cn(block, 'h-6 w-16')} />
          <span className={cn(block, 'h-6 w-6')} />
        </div>
        <div className="grid flex-1 grid-cols-7 gap-1.5">
          {Array.from({ length: 35 }, (_, i) => (
            <div key={i} className={cn(block, 'min-h-12 p-1.5')}>
              {[3, 9, 10, 16, 22, 24, 30].includes(i) && <span className="block h-1.5 w-3/4 rounded-full bg-accent/40" />}
              {[9, 24].includes(i) && <span className="mt-1 block h-1.5 w-1/2 rounded-full bg-line-heavy" />}
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (kind === 'composer') {
    return (
      <div className="flex h-full flex-col gap-3 pt-6">
        <div className="flex gap-2">
          {[20, 16, 24].map((w) => (
            <span key={w} className={cn(block, 'h-6')} style={{ width: `${w * 4}px` }} />
          ))}
        </div>
        <div className={cn(block, 'flex flex-col gap-2 p-3')}>
          <span className={cn(bar, 'w-5/6')} />
          <span className={cn(bar, 'w-2/3')} />
          <span className={cn(bar, 'w-3/4')} />
        </div>
        <div className="grid grid-cols-3 gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className={cn(block, 'flex flex-col gap-1.5 p-2.5', i === 0 && 'border-accent/40')}>
              <span className={cn(bar, 'w-full')} />
              <span className={cn(bar, 'w-4/5')} />
              <span className={cn(bar, 'w-3/5')} />
              <span className="mt-2 aspect-[16/9] rounded-xs border border-dashed border-line-heavy" />
            </div>
          ))}
        </div>
        <div className="mt-auto flex justify-end gap-2">
          <span className={cn(block, 'h-7 w-20')} />
          <span className="h-7 w-24 rounded-sm bg-accent/30" />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-2 pt-6">
      <div className="mb-1 flex gap-2">
        <span className={cn(block, 'h-7 flex-1')} />
        <span className={cn(block, 'h-7 w-20')} />
      </div>
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className={cn(block, 'flex items-center gap-3 px-3 py-2.5')}>
          <span className="size-5 shrink-0 rounded-full border border-dashed border-line-heavy" />
          <span className={cn(bar, i % 2 ? 'w-2/5' : 'w-1/2')} />
          <span className="flex-1" />
          <span className={cn(bar, 'w-14', i === 1 && 'bg-accent/40')} />
        </div>
      ))}
    </div>
  )
}
