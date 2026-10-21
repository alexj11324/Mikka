'use client'

import { Fragment, type ReactNode } from 'react'
import { Sparkles } from 'lucide-react'
import { MessageBubble, MessageBubbleContent } from '@/components/agents/message-bubble'
import { Message, MessageContent } from '@/components/agents/message'
import { MessageScroller } from '@/components/agents/message-scroller'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'

export type AgentTurn = { id: number; question: string; response: ReactNode }

export function AgentConversation({ turns, starters, streaming }: { turns: AgentTurn[]; starters: ReactNode; streaming: boolean }) {
  return <MessageScroller label="消息" navigation="rail" navigationLabel="对话导航" busy={streaming} className="min-h-0 flex-1" contentClassName="mx-auto w-full max-w-3xl gap-8 px-4 py-8 sm:px-6">
    {turns.length ? turns.map(turn => <Fragment key={turn.id}>
      <Message from="user" role="group" aria-label="你的问题">
        <MessageContent><MessageBubble variant="soft"><MessageBubbleContent className="whitespace-pre-wrap break-words">{turn.question}</MessageBubbleContent></MessageBubble></MessageContent>
      </Message>
      {turn.response}
    </Fragment>) : <Empty className="gap-6 py-10 sm:py-16">
      <EmptyHeader>
        <EmptyMedia variant="icon"><Sparkles aria-hidden="true" /></EmptyMedia>
        <EmptyTitle><h2>有什么可以帮你？</h2></EmptyTitle>
        <EmptyDescription>整理想法、拆解计划，把下一步变清楚。</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>{starters}</EmptyContent>
    </Empty>}
  </MessageScroller>
}
