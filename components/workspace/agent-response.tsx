'use client'

import { useAgentCopy } from '@/hooks/use-agent-copy'
import type { ActionEvent } from '@openuidev/react-lang'
import type { ReactNode } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { MessageBubble as Bubble, MessageBubbleContent as BubbleContent } from '@/components/agents/message-bubble'
import { Message, MessageContent } from '@/components/agents/message'
import { ReasoningText } from '@/components/agents/loading-states/reasoning-text'
import { StreamingResponse } from '@/components/agents/streaming-response'

import { AgentGenerativeUI } from './agent-generative-ui'
import { ReplyBubbles } from './agent-text-bubble'

/** A 1:1 chat names the bot in its title pill, so replies carry no avatar or byline. */
export function AgentResponse({ completion, error, isLoading, stopped = false, onAction, onRetry, waiting }: { /** Shown instead of the reasoning text until the first words arrive. */ waiting?: ReactNode; completion: string; error?: Error; isLoading: boolean; stopped?: boolean; onAction: (event: ActionEvent) => void; onRetry?: () => void }) {
  const agentCopy = useAgentCopy()

  if (!completion && !error && !isLoading) return null

  return <Message from="assistant" aria-label={agentCopy.agentResponse} animateIn={isLoading}>
    <MessageContent className="gap-3">
      <Bubble variant="ghost" className="w-full min-w-0">
        <BubbleContent className="flex w-full min-w-0 flex-col gap-4">
          {isLoading && !completion && waiting}
          {isLoading && !(waiting && !completion) && <ReasoningText variant="cascade" phrases={completion ? [agentCopy.continuingTheResponse, agentCopy.organizingResponseContent] : [agentCopy.preparingAResponse, agentCopy.waitingForAResponse]} />}
          {completion && <StreamingResponse status={error ? 'error' : isLoading ? 'streaming' : 'complete'} announce={false} showActions={false}>
            <div className="w-full min-w-0 overflow-x-auto break-words"><ReplyBubbles value><AgentGenerativeUI response={completion} isStreaming={isLoading} onAction={onAction} showErrors={!error && !stopped} onRetry={onRetry} /></ReplyBubbles></div>
          </StreamingResponse>}
          {error && <Alert variant="destructive"><AlertDescription>{error.message || agentCopy.requestFailedPleaseTryAgain} {agentCopy.yourInputHasBeenPreserved}{onRetry && <Button type="button" variant="outline" size="sm" disabled={isLoading} onClick={onRetry}>{agentCopy.retryThisResponse}</Button>}</AlertDescription></Alert>}
        </BubbleContent>
      </Bubble>
    </MessageContent>
  </Message>
}
