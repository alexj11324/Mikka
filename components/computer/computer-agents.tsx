'use client'

import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { listAgents } from '@/app/actions/agents'

export type ComputerAgent = { id: string; name: string }

type Registry = { agents: Record<string, ComputerAgent[]>; register: (conversation: string, agent: ComputerAgent) => void }

const RegistryContext = createContext<Registry | null>(null)
const ConversationContext = createContext<string | null>(null)

/**
 * Which bots' computers a conversation uses: every 电脑 card in it reports
 * its bot, so the 详情 tab beside the conversation can show that bot's
 * screen. Conversations are not linked to bots any other way yet.
 */
export function ComputerAgentsProvider({ children }: { children: ReactNode }) {
  const [agents, setAgents] = useState<Record<string, ComputerAgent[]>>({})
  const register = useCallback((conversation: string, agent: ComputerAgent) => {
    setAgents(current => {
      const list = current[conversation] ?? []
      if (list.some(item => item.id === agent.id && item.name === agent.name)) return current
      return { ...current, [conversation]: [...list.filter(item => item.id !== agent.id), agent] }
    })
  }, [])
  const value = useMemo(() => ({ agents, register }), [agents, register])
  return <RegistryContext value={value}>{children}</RegistryContext>
}

/** Marks the conversation the cards below belong to. */
export function ComputerConversation({ id, children }: { id: string | null; children: ReactNode }) {
  return <ConversationContext value={id}>{children}</ConversationContext>
}

/** The bot whose computer a conversation last used, for the 详情 tab. */
export function useConversationComputerAgent(conversation: string | null | undefined): ComputerAgent | null {
  const registry = use(RegistryContext)
  return conversation ? registry?.agents[conversation]?.at(-1) ?? null : null
}

/** A bot's display name: the one the card was given, else the bot list. */
export function useComputerAgentName(agentId: string, given?: string) {
  const { data } = useSWR(given ? null : 'agents', listAgents, { revalidateOnFocus: false })
  return given ?? data?.find(agent => agent.id === agentId)?.name ?? 'Agent'
}

export function useRegisterComputerAgent(agent: ComputerAgent) {
  const registry = use(RegistryContext)
  const conversation = use(ConversationContext)
  const register = registry?.register
  const { id, name } = agent
  useEffect(() => {
    if (register && conversation) register(conversation, { id, name })
  }, [register, conversation, id, name])
}
