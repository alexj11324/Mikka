import type { EveMessage, SessionStreamEvent } from 'eve/client'
import type { ChatItem } from '../../../lib/types'

/** A rendering adapter; imported history and domain decorations remain in the authorized chat reader. */
export function eveChatItems(agent: { messages: readonly EveMessage[]; session?: { sessionId: string }; events: readonly SessionStreamEvent[] }, stored: readonly ChatItem[]): ChatItem[] {
  const saved = new Set(stored.flatMap(item => item.streamId ? [item.streamId] : []))
  const firstAt = new Map<string, string>()
  for (const event of agent.events) if (event.scope?.turnId && !firstAt.has(event.scope.turnId)) firstAt.set(event.scope.turnId, event.meta.at)
  const lastPosition = stored.reduce((last, item) => Math.max(last, item.position), 0)
  return agent.messages.flatMap((message, index) => {
    const turnId = message.metadata?.turnId
    if (message.role !== 'assistant' || message.metadata?.imported || saved.has(message.id) || (turnId && saved.has(`eve:${agent.session?.sessionId}:${turnId}`))) return []
    const text = message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
    if (!text) return []
    return [{ position: lastPosition + index + 1, from: 'coordinator', text, threads: [], artifacts: [],
      streamId: message.id,
      createdAt: turnId ? firstAt.get(turnId) ?? '' : '',
    }]
  })
}
