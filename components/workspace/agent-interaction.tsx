'use client'

import { createContext, useContext } from 'react'

export const AgentInteractionContext = createContext<{
  busy: boolean
  continueFromAnswer: (prompt: string) => Promise<boolean>
  /**
   * The same send, saying why it did not go: the chat's own words for it (offline, a page build out of date, what the
   * server answered). Absent where the host has nothing more to say than 「did not go」.
   */
  answer?: (prompt: string) => Promise<{ sent: true } | { sent: false; reason?: string }>
}>({ busy: true, continueFromAnswer: async () => false })

export function useAgentInteraction() {
  return useContext(AgentInteractionContext)
}
