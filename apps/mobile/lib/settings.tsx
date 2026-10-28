import { createContext, type ReactNode, useContext } from 'react'
import { api } from '@/lib/api'
import type { Preferences, Settings } from '@/lib/types'
import { useApi } from '@/lib/useApi'

type SettingsState = ReturnType<typeof useApi<Settings>> & { savePreferences: (patch: Partial<Preferences>) => Promise<void> }
const SettingsContext = createContext<SettingsState | null>(null)

/** Settings load once for all their pages; a switch changes at once and is saved behind it. */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const state = useApi<Settings>('/api/mobile/settings')
  const savePreferences = async (patch: Partial<Preferences>) => {
    state.setData(current => current && { ...current, preferences: { ...current.preferences, ...patch } })
    try {
      const preferences = await api<Preferences>('/api/mobile/preferences', { method: 'PATCH', body: patch })
      state.setData(current => current && { ...current, preferences })
    } catch {
      await state.reload()
    }
  }
  return <SettingsContext.Provider value={{ ...state, savePreferences }}>{children}</SettingsContext.Provider>
}

export function useSettings(): SettingsState {
  const state = useContext(SettingsContext)
  if (!state) throw new Error('useSettings outside SettingsProvider')
  return state
}
