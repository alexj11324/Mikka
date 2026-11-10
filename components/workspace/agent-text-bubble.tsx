'use client'

import { createContext, use, type ReactNode } from 'react'

/**
 * On in chat replies: the reply's own text sits in a bubble, like the user's messages. Unset (undefined) until a chat
 * says: a host that draws its own message frame (the hosted thread and chat-message slots) sets it off, and a reply
 * inside such a frame keeps it off instead of turning bubbles back on (CoordinatorReply).
 */
export const ReplyBubbles = createContext<boolean | undefined>(undefined)
/** On inside a card, table or other block, whose text stays as it is. */
export const InsideBlock = createContext(false)

/**
 * Text the bot writes goes in a grey bubble, as the user's messages do; charts,
 * cards and tables stand on their own, and text inside them gets no bubble.
 */
export function AgentTextBubble({ children }: { children: ReactNode }) {
  const bubbles = use(ReplyBubbles)
  const nested = use(InsideBlock)
  if (!bubbles || nested) return children
  return <div data-agent-text className="w-fit max-w-[82%] min-w-0 rounded-2xl bg-muted px-4 py-2.5 wrap-break-word">{children}</div>
}
