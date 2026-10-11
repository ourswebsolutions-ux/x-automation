/**
 * Axora Relay mark: two offset strokes forming a forward relay — a message
 * handed from one point to the next.
 */
export function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="0.5" y="0.5" width="19" height="19" rx="5.5" fill="var(--surface-3)" stroke="var(--line-heavy)" />
      <path d="M5.5 13.5 9 6.5" stroke="var(--fg-muted)" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M9.5 13.5 13 6.5" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="14.6" cy="13.4" r="1.15" fill="var(--accent)" />
    </svg>
  )
}
