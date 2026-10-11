import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

interface UiContextValue {
  paletteOpen: boolean
  setPaletteOpen: (open: boolean) => void
  shortcutsOpen: boolean
  setShortcutsOpen: (open: boolean) => void
}

const UiContext = createContext<UiContextValue | null>(null)

/** Global overlay state (command palette, shortcuts sheet). */
export function UiProvider({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const value = useMemo(() => ({ paletteOpen, setPaletteOpen, shortcutsOpen, setShortcutsOpen }), [paletteOpen, shortcutsOpen])
  return <UiContext.Provider value={value}>{children}</UiContext.Provider>
}

export function useUi() {
  const context = useContext(UiContext)
  if (!context) throw new Error('useUi must be used inside <UiProvider>')
  return context
}
