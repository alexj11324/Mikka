import { createContext, type ReactNode, useContext, useMemo, useRef, useSyncExternalStore } from 'react'
import { api } from '@/lib/api'
import type { Preferences, Settings } from '@/lib/types'
import { useApi } from '@/lib/useApi'
import { apiCache } from './api-cache'
import { PreferenceWrites, type PreferenceWriteState } from './preference-writes'

type SettingsState = ReturnType<typeof useApi<Settings>> & { savePreferences: (patch: Partial<Preferences>) => Promise<boolean>; preferenceSave: PreferenceWriteState<Preferences>; retryPreferences: () => Promise<boolean> }
const SettingsContext = createContext<SettingsState | null>(null)

/** Settings load once; switches show confirmed values while pending intentions are explicit. */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const state = useApi<Settings>('/api/mobile/settings?view=profile')
  const identity = apiCache.account()
  const currentState = useRef(state)
  currentState.current = state
  const writer = useMemo(() => new PreferenceWrites<Preferences>({
    write: patch => api<Preferences>('/api/mobile/preferences', { method: 'PATCH', body: patch }),
    confirm: preferences => {
      currentState.current.setData(current => current && { ...current, preferences: { ...current.preferences, ...preferences } })
      // Preferences follow the account even when this modal switched workspace meanwhile.
      void currentState.current.reload()
    },
    current: () => apiCache.account() === identity,
  }), [identity])
  const preferenceSave = useSyncExternalStore(writer.subscribe, writer.snapshot, writer.snapshot)
  return <SettingsContext.Provider value={{ ...state, savePreferences: patch => writer.save(patch), preferenceSave, retryPreferences: writer.retry }}>{children}</SettingsContext.Provider>
}

export function useSettings(): SettingsState {
  const state = useContext(SettingsContext)
  if (!state) throw new Error('useSettings outside SettingsProvider')
  return state
}
