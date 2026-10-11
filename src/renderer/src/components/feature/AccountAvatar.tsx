import { cn } from '@/lib/cn'

/** Initials tile. Hue is derived from the handle so each account is recognisable. */
export function AccountAvatar({ name, handle, size = 28 }: { name: string; handle: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
  const hue = [...handle].reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) % 360, 7)
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        background: `color-mix(in oklch, oklch(0.62 0.07 ${hue}) 22%, var(--surface-3))`,
        color: `color-mix(in oklch, oklch(0.8 0.08 ${hue}) 70%, var(--fg))`
      }}
      className={cn('grid shrink-0 place-items-center rounded-full border border-line-strong text-2xs font-semibold')}
    >
      {initials}
    </span>
  )
}
