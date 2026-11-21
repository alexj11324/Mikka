import type { EveMessage, SessionStreamEvent } from 'eve/client'
import type { ChatItem } from '../../../lib/types'
import { isOpenUI, openUIRootCount } from '../../../lib/openui'

type RenderedItem = ChatItem & { cardDocument?: { stream: string; root: number } }

/** The last OpenUI root in a settled turn is the same document that was shown in its live SDK message. */
export function generatedCardDocument(item: RenderedItem): string | null {
  if (item.from !== 'coordinator' || !isOpenUI(item.text)) return null
  const stream = item.streamId ?? item.id ?? `position:${item.position}`
  const document = item.cardDocument ?? { stream, root: openUIRootCount(item.text) }
  return JSON.stringify([document.stream, document.root])
}

/** A rendering adapter; imported history and domain decorations remain in the authorized chat reader. */
export function eveChatItems(agent: { messages: readonly EveMessage[]; session?: { sessionId: string }; events: readonly SessionStreamEvent[] }, stored: readonly ChatItem[]): RenderedItem[] {
  const saved = new Set(stored.flatMap(item => item.streamId ? [item.streamId] : []))
  const firstAt = new Map<string, string>()
  for (const event of agent.events) if (event.scope?.turnId && !firstAt.has(event.scope.turnId)) firstAt.set(event.scope.turnId, event.meta.at)
  const lastPosition = stored.reduce((last, item) => Math.max(last, item.position), 0)
  const rootsByTurn = new Map<string, number>()
  return agent.messages.flatMap((message, index) => {
    const turnId = message.metadata?.turnId
    if (message.role !== 'assistant' || message.metadata?.imported || (turnId && saved.has(`eve:${agent.session?.sessionId}:${turnId}`))) return []
    const text = message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
    if (!text) return []
    const roots = openUIRootCount(text)
    let cardDocument: RenderedItem['cardDocument']
    if (roots && turnId && agent.session) {
      const ordinal = (rootsByTurn.get(turnId) ?? 0) + roots
      rootsByTurn.set(turnId, ordinal)
      cardDocument = { stream: `eve:${agent.session.sessionId}:${turnId}`, root: ordinal }
    }
    if (saved.has(message.id)) return []
    return [{ position: lastPosition + index + 1, from: 'coordinator', text, threads: [], artifacts: [],
      streamId: message.id, ...(cardDocument ? { cardDocument } : {}),
      createdAt: turnId ? firstAt.get(turnId) ?? '' : '',
    }]
  })
}
