'use client'

import dynamic from 'next/dynamic'
import type { ActionEvent } from '@openuidev/react-lang'
import { Sparkles } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Message, MessageContent, MessageHeader } from '@/components/ui/message'
import { Spinner } from '@/components/ui/spinner'

const AgentGenerativeUI = dynamic(() => import('./agent-generative-ui').then(module => module.AgentGenerativeUI), {
  ssr: false,
  loading: () => <p role="status" className="text-xs text-muted-foreground">正在加载生成界面…</p>,
})

export function AgentResponse({ completion, error, isLoading, onAction }: { completion: string; error?: Error; isLoading: boolean; onAction: (event: ActionEvent) => void }) {
  if (!completion && !error && !isLoading) return null

  return <Message role="group" aria-label="Agent 回复">
    <MessageContent>
      <MessageHeader className="gap-2"><Sparkles aria-hidden="true" />Agent</MessageHeader>
      <Bubble variant="ghost" className="w-full min-w-0">
        <BubbleContent className="flex w-full min-w-0 flex-col gap-4">
          {isLoading && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="size-3" />正在生成回复…</p>}
          {completion && <div aria-busy={isLoading} className="w-full min-w-0 overflow-x-auto break-words"><AgentGenerativeUI response={completion} isStreaming={isLoading} onAction={onAction} /></div>}
          {error && <Alert variant="destructive"><AlertDescription>{error.message || '请求失败，请稍后重试。'} 你的输入已保留，可重新发送。</AlertDescription></Alert>}
        </BubbleContent>
      </Bubble>
    </MessageContent>
  </Message>
}
