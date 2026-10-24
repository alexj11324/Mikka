'use client'

import { useAgentCopy } from '@/hooks/use-agent-copy'
import { Fragment, type ReactNode } from 'react'
import { MessageBubble, MessageBubbleContent } from '@/components/agents/message-bubble'
import { Message, MessageContent, MessageGroup } from '@/components/agents/message'
import { MessageScroller } from '@/components/agents/message-scroller'

export type AgentTurn = { id: number | string; question: string; response: ReactNode }

export function AgentConversation({ turns, streaming }: { turns: AgentTurn[]; streaming: boolean }) {
  const agentCopy = useAgentCopy()

  return <MessageScroller label={agentCopy.messages} navigation="rail" navigationLabel={agentCopy.conversationNavigation} busy={streaming} className="min-h-0 flex-1" viewportClassName="px-3 py-5 sm:px-5" contentClassName="mx-auto min-h-full w-full max-w-3xl">
    <MessageGroup spacing="default">
      {turns.map(turn => <Fragment key={turn.id}>
        <Message id={`agent-turn-${turn.id}`} from="user" aria-label={agentCopy.yourQuestion} animateIn={streaming && turn.id === turns.at(-1)?.id}>
          <MessageContent>
            <MessageBubble variant="solid"><MessageBubbleContent className="whitespace-pre-wrap break-words">{turn.question}</MessageBubbleContent></MessageBubble>
          </MessageContent>
        </Message>
        {turn.response}
      </Fragment>)}
    </MessageGroup>
  </MessageScroller>
}
