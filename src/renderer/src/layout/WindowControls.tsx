import { useEffect, useState } from 'react'
import { cn } from '@/lib/cn'
import { relay } from '@/lib/bridge'

/** Windows-style caption buttons. Hidden on macOS, which keeps native traffic lights. */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    relay.window.getState().then((state) => setMaximized(state.isMaximized), () => undefined)
    return relay.window.onStateChange((state) => setMaximized(state.isMaximized))
  }, [])

  const base =
    'no-drag grid h-full w-[46px] place-items-center text-fg-muted transition-colors duration-100 focus-visible:outline-none focus-visible:bg-neutral-soft'

  return (
    <div className="flex h-full items-stretch" role="group" aria-label="Window controls">
      <button type="button" aria-label="Minimize" className={cn(base, 'hover:bg-neutral-soft hover:text-fg')} onClick={() => relay.window.minimize()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button
        type="button"
        aria-label={maximized ? 'Restore' : 'Maximize'}
        className={cn(base, 'hover:bg-neutral-soft hover:text-fg')}
        onClick={() => relay.window.toggleMaximize()}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
            <path d="M2.5 2.5V.5h7v7h-2" stroke="currentColor" strokeWidth="1" />
            <rect x=".5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
            <rect x=".5" y=".5" width="9" height="9" stroke="currentColor" strokeWidth="1" />
          </svg>
        )}
      </button>
      <button
        type="button"
        aria-label="Close"
        className={cn(base, 'hover:bg-[#c42b1c] hover:text-white')}
        onClick={() => relay.window.close()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  )
}
