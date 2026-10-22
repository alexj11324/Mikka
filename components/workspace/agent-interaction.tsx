'use client'

import { createContext, useContext } from 'react'

export const AgentInteractionContext = createContext<{
  busy: boolean
  continueFromAnswer: (prompt: string) => Promise<boolean>
}>({ busy: true, continueFromAnswer: async () => false })

export function useAgentInteraction() {
  return useContext(AgentInteractionContext)
}
