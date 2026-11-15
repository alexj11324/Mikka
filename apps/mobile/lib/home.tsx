import { createContext, type ReactNode, useContext } from 'react'
import type { Home } from '@/lib/types'
import { useLiveApi } from '@/lib/useApi'
import { listRef } from '@/lib/live'

type HomeState = ReturnType<typeof useLiveApi<Home>>
const HomeContext = createContext<HomeState | null>(null)

/** The live keys behind the tabs and the account sheet, the same the web's lists listen to (hooks/use-live-lists.ts). */
export function homeLive(home: Home | null) {
  // Until the first answer (or after a failed one) it reads once a minute, as before.
  if (!home) return { refs: [listRef('bot_chat_list', null)] }
  const own = home.live?.workspaceId ?? null, open = home.workspace.id
  return {
    minIntervalMs: 2_000,
    refs: [
      // Bot chats use the owner's home channel. Run counts follow the selected workspace.
      listRef('bot_chat_list', own),
      listRef('thread_list', open),
      // The open workspace's bots, and its name and the workspace list.
      listRef('bot_list', open),
      listRef('workspace_settings', open),
      ...(own && own !== open ? [listRef('workspace_settings', own)] : []),
    ],
  }
}

/** The home data (the person, workspace, bots, counts), loaded once for every screen and read again when it changes. */
export function HomeProvider({ children }: { children: ReactNode }) {
  const state = useLiveApi<Home>('/api/mobile/home', homeLive)
  return <HomeContext.Provider value={state}>{children}</HomeContext.Provider>
}

export function useHome(): HomeState {
  const state = useContext(HomeContext)
  if (!state) throw new Error('useHome outside HomeProvider')
  return state
}
