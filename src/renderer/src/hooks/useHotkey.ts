import { useEffect, useRef } from 'react'

interface HotkeyOptions {
  /** Fire even when focus is inside an input or textarea. */
  allowInInputs?: boolean
  enabled?: boolean
}

/**
 * Binds a keyboard shortcut such as "mod+k", "mod+,", "/" or "shift+?".
 * "mod" maps to Ctrl on Windows/Linux and ⌘ on macOS.
 */
export function useHotkey(combo: string, handler: (event: KeyboardEvent) => void, options: HotkeyOptions = {}) {
  const { allowInInputs = false, enabled = true } = options
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    if (!enabled) return
    const parts = combo.toLowerCase().split('+')
    const key = parts.pop()
    const wantsMod = parts.includes('mod')
    const wantsShift = parts.includes('shift')
    const wantsAlt = parts.includes('alt')
    const isMac = navigator.userAgent.includes('Mac')

    const onKeyDown = (event: KeyboardEvent) => {
      const mod = isMac ? event.metaKey : event.ctrlKey
      if (wantsMod !== mod || wantsAlt !== event.altKey) return
      if (key !== '?' && wantsShift !== event.shiftKey) return
      if (event.key.toLowerCase() !== key) return
      const target = event.target as HTMLElement | null
      const typing = target?.closest('input, textarea, [contenteditable="true"]')
      if (typing && !allowInInputs && !wantsMod) return
      event.preventDefault()
      handlerRef.current(event)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [combo, allowInInputs, enabled])
}

export const MOD_LABEL = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl'
