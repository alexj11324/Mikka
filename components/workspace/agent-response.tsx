'use client'

import type { ActionEvent } from '@openuidev/react-lang'
import { Bot } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { MessageBubble as Bubble, MessageBubbleContent as BubbleContent } from '@/components/agents/message-bubble'
import { Message, MessageAvatar, MessageContent, MessageHeader } from '@/components/agents/message'
import { AgentProgress } from '@/components/agents/loading-states/agent-progress'
import { StreamingResponse } from '@/components/agents/streaming-response'

import { AgentGenerativeUI } from './agent-generative-ui'

export function AgentResponse({ completion, error, isLoading, stopped = false, onAction, onRetry }: { completion: string; error?: Error; isLoading: boolean; stopped?: boolean; onAction: (event: ActionEvent) => void; onRetry?: () => void }) {
  if (!completion && !error && !isLoading) return null

  return <Message from="assistant" aria-label="Agent 回复" animateIn={isLoading}>
    <MessageAvatar><Bot aria-hidden="true" /></MessageAvatar>
    <MessageContent className="gap-3">
      <MessageHeader>Agent</MessageHeader>
      <Bubble variant="ghost" className="w-full min-w-0">
        <BubbleContent className="flex w-full min-w-0 flex-col gap-4">
          {isLoading && <AgentProgress label={completion ? '正在继续生成回复' : 'thinking'} />}
          {completion && <StreamingResponse status={error ? 'error' : isLoading ? 'streaming' : 'complete'} announce={false} showActions={false}>
            <div className="w-full min-w-0 overflow-x-auto break-words"><AgentGenerativeUI response={completion} isStreaming={isLoading} onAction={onAction} showErrors={!error && !stopped} onRetry={onRetry} /></div>
          </StreamingResponse>}
          {error && <Alert variant="destructive"><AlertDescription>{error.message || '请求失败，请稍后重试。'} 你的输入已保留。{onRetry && <Button type="button" variant="outline" size="sm" disabled={isLoading} onClick={onRetry}>重试此回复</Button>}</AlertDescription></Alert>}
        </BubbleContent>
      </Bubble>
    </MessageContent>
  </Message>
}
