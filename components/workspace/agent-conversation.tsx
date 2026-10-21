'use client'

import { Fragment, type ReactNode } from 'react'
import { Bot, User } from 'lucide-react'
import { MessageBubble, MessageBubbleContent } from '@/components/agents/message-bubble'
import { Message, MessageAvatar, MessageContent, MessageFooter, MessageGroup, MessageHeader } from '@/components/agents/message'
import { MessageScroller } from '@/components/agents/message-scroller'

export type AgentTurn = { id: number | string; question: string; response: ReactNode }

export function AgentConversation({ turns, streaming }: { turns: AgentTurn[]; streaming: boolean }) {
  return <MessageScroller label="消息" navigation="rail" navigationLabel="对话导航" busy={streaming} className="min-h-0 flex-1" viewportClassName="px-3 py-5 sm:px-5" contentClassName="mx-auto min-h-full w-full max-w-3xl">
    <MessageGroup spacing="default">
      {turns.length ? turns.map(turn => <Fragment key={turn.id}>
        <Message id={`agent-turn-${turn.id}`} from="user" aria-label="你的问题" animateIn>
          <MessageAvatar><User aria-hidden="true" /></MessageAvatar>
          <MessageContent>
            <MessageHeader>你</MessageHeader>
            <MessageBubble variant="solid"><MessageBubbleContent className="whitespace-pre-wrap break-words">{turn.question}</MessageBubbleContent></MessageBubble>
            <MessageFooter>已发送</MessageFooter>
          </MessageContent>
        </Message>
        {turn.response}
      </Fragment>) : <Message from="assistant" aria-label="Agent 使用说明">
        <MessageAvatar><Bot aria-hidden="true" /></MessageAvatar>
        <MessageContent>
          <MessageHeader>Agent</MessageHeader>
          <MessageBubble variant="soft"><MessageBubbleContent>告诉我你要完成的任务。我可以帮你拆解计划、整理清单或比较方案。点击输入栏的加号，选择一个起点。</MessageBubbleContent></MessageBubble>
          <MessageFooter>对话按账号保存，可随时回来继续；不读取或修改工作区。</MessageFooter>
        </MessageContent>
      </Message>}
    </MessageGroup>
  </MessageScroller>
}
