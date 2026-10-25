'use client'

import { useAgentCopy } from '@/hooks/use-agent-copy'
import type { ActionEvent } from '@openuidev/react-lang'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { MessageBubble as Bubble, MessageBubbleContent as BubbleContent } from '@/components/agents/message-bubble'
import { Message, MessageContent, MessageHeader } from '@/components/agents/message'
import { BotAvatar } from '@/components/nav/bot-avatar'
import { ReasoningText } from '@/components/agents/loading-states/reasoning-text'
import { StreamingResponse } from '@/components/agents/streaming-response'

import { AgentGenerativeUI } from './agent-generative-ui'

export function AgentResponse({ completion, error, isLoading, stopped = false, onAction, onRetry }: { completion: string; error?: Error; isLoading: boolean; stopped?: boolean; onAction: (event: ActionEvent) => void; onRetry?: () => void }) {
  const agentCopy = useAgentCopy()

  if (!completion && !error && !isLoading) return null

  return <Message from="assistant" aria-label={agentCopy.agentResponse} animateIn={isLoading}>
    <BotAvatar size="search" mood={isLoading ? 'thinking' : 'idle'} />
    <MessageContent className="gap-3">
      <MessageHeader>Agent</MessageHeader>
      <Bubble variant="ghost" className="w-full min-w-0">
        <BubbleContent className="flex w-full min-w-0 flex-col gap-4">
          {isLoading && <ReasoningText variant="cascade" phrases={completion ? [agentCopy.continuingTheResponse, agentCopy.organizingResponseContent] : [agentCopy.preparingAResponse, agentCopy.waitingForAResponse]} />}
          {completion && <StreamingResponse status={error ? 'error' : isLoading ? 'streaming' : 'complete'} announce={false} showActions={false}>
            <div className="w-full min-w-0 overflow-x-auto break-words"><AgentGenerativeUI response={completion} isStreaming={isLoading} onAction={onAction} showErrors={!error && !stopped} onRetry={onRetry} /></div>
          </StreamingResponse>}
          {error && <Alert variant="destructive"><AlertDescription>{error.message || agentCopy.requestFailedPleaseTryAgain} {agentCopy.yourInputHasBeenPreserved}{onRetry && <Button type="button" variant="outline" size="sm" disabled={isLoading} onClick={onRetry}>{agentCopy.retryThisResponse}</Button>}</AlertDescription></Alert>}
        </BubbleContent>
      </Bubble>
    </MessageContent>
  </Message>
}
