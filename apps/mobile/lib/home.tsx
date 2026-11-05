import { createContext, type ReactNode, useContext } from 'react'
import type { Home } from '@/lib/types'
import { useLiveApi } from '@/lib/useApi'
import { listRef } from '@/lib/live'

type HomeState = ReturnType<typeof useLiveApi<Home>>
const HomeContext = createContext<HomeState | null>(null)

/** The live keys behind the drawer, the same the web's lists listen to (hooks/use-live-lists.ts). */
export function homeLive(home: Home | null) {
  // Until the first answer (or after a failed one) it reads once a minute, as before.
  if (!home) return { refs: [listRef('bot_chat_list', null)] }
  const own = home.live?.workspaceId ?? null, open = home.workspace.id
  return {
    minIntervalMs: 2_000,
    refs: [
      // Each bot's latest line, working and pin; the 线程 counts (both owner-wide, on the person's home channel).
      listRef('bot_chat_list', own),
      listRef('thread_list', own),
      // The open workspace's bots, and its name and the workspace list.
      listRef('bot_list', open),
      listRef('workspace_settings', open),
      ...(own && own !== open ? [listRef('workspace_settings', own)] : []),
    ],
  }
}

/** The drawer's data (the person, workspace, bots, counts), loaded once for every screen and read again when it changes. */
export function HomeProvider({ children }: { children: ReactNode }) {
  const state = useLiveApi<Home>('/api/mobile/home', homeLive)
  return <HomeContext.Provider value={state}>{children}</HomeContext.Provider>
}

export function useHome(): HomeState {
  const state = useContext(HomeContext)
  if (!state) throw new Error('useHome outside HomeProvider')
  return state
}
