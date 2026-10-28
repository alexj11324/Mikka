import { createContext, type ReactNode, useContext } from 'react'
import type { Home } from '@/lib/types'
import { useApi } from '@/lib/useApi'

type HomeState = ReturnType<typeof useApi<Home>>
const HomeContext = createContext<HomeState | null>(null)

/** The drawer's data (the person, workspace, bots, counts), loaded once for every screen and refreshed each minute. */
export function HomeProvider({ children }: { children: ReactNode }) {
  const state = useApi<Home>('/api/mobile/home', 60_000)
  return <HomeContext.Provider value={state}>{children}</HomeContext.Provider>
}

export function useHome(): HomeState {
  const state = useContext(HomeContext)
  if (!state) throw new Error('useHome outside HomeProvider')
  return state
}
