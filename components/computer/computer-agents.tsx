'use client'

import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { getThreadName, listAgents } from '@/app/actions/agents'
import { isMockedComputer } from '@/lib/computer/client'

/** A thread that uses a bot's computer: the run, its name, and the bot that owns both. */
export type ComputerThread = { agentId: string; agentName: string; runId: string; name: string }

type Registry = { threads: Record<string, ComputerThread[]>; register: (conversation: string, thread: ComputerThread) => void }

const RegistryContext = createContext<Registry | null>(null)
const ConversationContext = createContext<string | null>(null)

const same = (a: ComputerThread, b: ComputerThread) => a.runId === b.runId && a.agentId === b.agentId && a.agentName === b.agentName && a.name === b.name

/**
 * Which threads a conversation's bot is running on its computer: every 电脑
 * card in it reports its thread, so the 详情 tab beside the conversation
 * shows that thread and the bot's screen, and switches with the
 * conversation. Conversations are not linked to bots any other way yet.
 */
export function ComputerAgentsProvider({ children }: { children: ReactNode }) {
  const [threads, setThreads] = useState<Record<string, ComputerThread[]>>({})
  const register = useCallback((conversation: string, thread: ComputerThread) => {
    setThreads(current => {
      const list = current[conversation] ?? []
      if (list.some(item => same(item, thread))) return current
      return { ...current, [conversation]: [...list.filter(item => item.runId !== thread.runId), thread] }
    })
  }, [])
  const value = useMemo(() => ({ threads, register }), [threads, register])
  return <RegistryContext value={value}>{children}</RegistryContext>
}

/** Marks the conversation the cards below belong to. */
export function ComputerConversation({ id, children }: { id: string | null; children: ReactNode }) {
  return <ConversationContext value={id}>{children}</ConversationContext>
}

/** The thread a conversation's bot last ran on its computer, for the 详情 tab. */
export function useConversationThread(conversation: string | null | undefined): ComputerThread | null {
  const registry = use(RegistryContext)
  return conversation ? registry?.threads[conversation]?.at(-1) ?? null : null
}

/** A bot's display name: the one the card was given, else the bot list. */
export function useComputerAgentName(agentId: string, given?: string) {
  const { data } = useSWR(given ? null : 'agents', listAgents, { revalidateOnFocus: false })
  return given ?? data?.find(agent => agent.id === agentId)?.name ?? 'Agent'
}

/** A thread's name from its task; the card's own name, then its task sentence, until that is known. */
export function useThreadName(agentId: string, runId: string, given: string | undefined, fallback: string) {
  const { data } = useSWR(given || isMockedComputer(agentId) ? null : ['thread-name', runId], ([, id]: [string, string]) => getThreadName(id), { revalidateOnFocus: false })
  return given ?? data ?? fallback
}

export function useRegisterComputerThread(thread: ComputerThread) {
  const registry = use(RegistryContext)
  const conversation = use(ConversationContext)
  const register = registry?.register
  const { agentId, agentName, runId, name } = thread
  useEffect(() => {
    if (register && conversation) register(conversation, { agentId, agentName, runId, name })
  }, [register, conversation, agentId, agentName, runId, name])
}
