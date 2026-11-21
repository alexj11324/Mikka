'use client'

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useEveAgent } from 'eve/react'
import { idle } from 'eve/events'
import { coordinatorAgentUrl } from '@/lib/eve/client'
import { coordinatorAgentReplies } from '@/lib/eve/chat-view'

/** One eve store supplies transport, replay, optimistic input, tools and child-agent lifecycle. */
export function useCoordinatorAgent({ botId, enabled, persistedStreamIds, revalidate }: {
  botId: string | null
  enabled: boolean
  persistedStreamIds?: readonly string[]
  revalidate: () => Promise<unknown>
}) {
  const refresh = useRef(revalidate)
  refresh.current = revalidate
  const agent = useEveAgent({
    baseUrl: coordinatorAgentUrl(botId),
    followAgents: true,
    followWhile: view => !idle(view),
    onFinish: () => { void refresh.current().catch(() => undefined) },
  })
  const { prewarm, resume } = agent
  useEffect(() => {
    if (!enabled) return
    let attached = true
    // Creation resolves the server-owned bot mapping, including on a page reload.
    void prewarm().then(() => attached ? resume() : undefined).catch(() => undefined)
    return () => { attached = false }
  }, [enabled, prewarm, resume])
  const reconnect = useCallback(() => {
    if (enabled && agent.session) void resume().catch(() => undefined)
  }, [enabled, agent.session?.sessionId, resume])
  const replies = useMemo(() => coordinatorAgentReplies(agent.messages, persistedStreamIds, agent.session?.sessionId), [agent.messages, persistedStreamIds, agent.session?.sessionId])
  return { ...agent, replies, reconnect }
}
