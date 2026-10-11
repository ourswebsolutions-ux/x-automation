import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Preferences, PreferencesPatch } from '@shared/types/preferences'
import { useToast } from '@/components/ui'
import { errorMessage, relay } from '@/lib/bridge'

interface PreferencesContextValue {
  preferences: Preferences
  resolvedTheme: 'dark' | 'light'
  update: (patch: PreferencesPatch) => Promise<boolean>
  reset: () => Promise<void>
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null)

function useSystemTheme(): 'dark' | 'light' {
  const query = '(prefers-color-scheme: dark)'
  const [dark, setDark] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const media = window.matchMedia(query)
    const onChange = () => setDark(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return dark ? 'dark' : 'light'
}

/**
 * Owns user preferences. The main process is the source of truth; this
 * provider mirrors it, applies theme/motion to <html>, and exposes updates.
 */
export function PreferencesProvider({ initial, children }: { initial: Preferences; children: ReactNode }) {
  const [preferences, setPreferences] = useState(initial)
  const toast = useToast()
  const systemTheme = useSystemTheme()
  const resolvedTheme = preferences.theme === 'system' ? systemTheme : preferences.theme

  useEffect(() => relay.preferences.onChange(setPreferences), [])

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = resolvedTheme
    root.dataset.reduceMotion = String(preferences.reduceMotion)
  }, [resolvedTheme, preferences.reduceMotion])

  const update = useCallback(
    async (patch: PreferencesPatch) => {
      try {
        setPreferences(await relay.preferences.update(patch))
        return true
      } catch (error) {
        toast({ tone: 'danger', title: 'Setting not saved', description: errorMessage(error) })
        return false
      }
    },
    [toast]
  )

  const reset = useCallback(async () => {
    setPreferences(await relay.preferences.reset())
  }, [])

  const value = useMemo(
    () => ({ preferences, resolvedTheme, update, reset }),
    [preferences, resolvedTheme, update, reset]
  )
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>
}

export function usePreferences() {
  const context = useContext(PreferencesContext)
  if (!context) throw new Error('usePreferences must be used inside <PreferencesProvider>')
  return context
}
