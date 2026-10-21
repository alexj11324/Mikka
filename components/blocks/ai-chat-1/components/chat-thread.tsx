'use client'

import type { ReactNode } from 'react'
import { ArrowDown, Sparkles } from 'lucide-react'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Message, MessageContent } from '@/components/ui/message'
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from '@/components/ui/message-scroller'

export function ChatThread({ question, response, starters }: { question: string; response: ReactNode; starters: ReactNode }) {
  return <MessageScrollerProvider>
    <MessageScroller className="flex-1">
      <MessageScrollerViewport aria-label="消息">
        <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-8 px-4 py-8 sm:px-6">
          {question ? <>
            <MessageScrollerItem scrollAnchor>
              <Message align="end" role="group" aria-label="你的问题">
                <MessageContent><Bubble variant="secondary" align="end"><BubbleContent className="whitespace-pre-wrap">{question}</BubbleContent></Bubble></MessageContent>
              </Message>
            </MessageScrollerItem>
            <MessageScrollerItem>{response}</MessageScrollerItem>
          </> : <MessageScrollerItem className="flex flex-1 flex-col justify-center gap-8 py-10 sm:py-16">
            <div className="flex flex-col items-center gap-4 text-center">
              <Sparkles className="size-7 text-muted-foreground" aria-hidden="true" />
              <h2 className="text-2xl font-medium tracking-tight sm:text-3xl">有什么可以帮你？</h2>
              <p className="text-sm text-muted-foreground">整理想法、拆解计划，把下一步变清楚。</p>
            </div>
            {starters}
          </MessageScrollerItem>}
        </MessageScrollerContent>
      </MessageScrollerViewport>
      <MessageScrollerButton aria-label="滚动到最新回复"><ArrowDown aria-hidden="true" /><span className="sr-only">滚动到最新回复</span></MessageScrollerButton>
    </MessageScroller>
  </MessageScrollerProvider>
}
