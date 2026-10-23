'use client'

import { useAgentCopy } from '@/hooks/use-agent-copy'
import type { ActionEvent } from '@openuidev/react-lang'
import { Bot } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { MessageBubble as Bubble, MessageBubbleContent as BubbleContent } from '@/components/agents/message-bubble'
import { Message, MessageAvatar, MessageContent, MessageHeader } from '@/components/agents/message'
import { ReasoningText } from '@/components/agents/loading-states/reasoning-text'
import { StreamingResponse } from '@/components/agents/streaming-response'

import { Trace, TraceLine, TraceTitle } from '@/components/ui/trace'
import type { AgentStatus } from '@/lib/agent-status'
import { AgentGenerativeUI } from './agent-generative-ui'

export function AgentResponse({ completion, error, isLoading, stopped = false, statusSteps = [], onAction, onRetry }: { completion: string; error?: Error; isLoading: boolean; stopped?: boolean; statusSteps?: AgentStatus[]; onAction: (event: ActionEvent) => void; onRetry?: () => void }) {
  const agentCopy = useAgentCopy()

  if (!completion && !error && !isLoading) return null
  const statusLabel = { thinking: agentCopy.agentStatusThinking, searching: agentCopy.agentStatusSearching, reading: agentCopy.agentStatusReading, working: agentCopy.agentStatusWorking }
  const showTrace = isLoading && !completion && statusSteps.length > 0

  return <Message from="assistant" aria-label={agentCopy.agentResponse} animateIn={isLoading}>
    <MessageAvatar><Bot aria-hidden="true" /></MessageAvatar>
    <MessageContent className="gap-3">
      <MessageHeader>Agent</MessageHeader>
      <Bubble variant="ghost" className="w-full min-w-0">
        <BubbleContent className="flex w-full min-w-0 flex-col gap-4">
          {showTrace && <Trace data-testid="agent-status-trace" aria-live="polite">
            {statusSteps.map((step, index) => <div key={index}><TraceLine status={index === statusSteps.length - 1 ? 'running' : undefined} data-phase={step.phase}><TraceTitle>{statusLabel[step.phase] ?? agentCopy.agentStatusWorking}</TraceTitle></TraceLine></div>)}
          </Trace>}
          {isLoading && !showTrace && <ReasoningText variant="cascade" phrases={completion ? [agentCopy.continuingTheResponse, agentCopy.organizingResponseContent] : [agentCopy.preparingAResponse, agentCopy.waitingForAResponse]} />}
          {completion && <StreamingResponse status={error ? 'error' : isLoading ? 'streaming' : 'complete'} announce={false} showActions={false}>
            <div className="w-full min-w-0 overflow-x-auto break-words"><AgentGenerativeUI response={completion} isStreaming={isLoading} onAction={onAction} showErrors={!error && !stopped} onRetry={onRetry} /></div>
          </StreamingResponse>}
          {error && <Alert variant="destructive"><AlertDescription>{error.message || agentCopy.requestFailedPleaseTryAgain} {agentCopy.yourInputHasBeenPreserved}{onRetry && <Button type="button" variant="outline" size="sm" disabled={isLoading} onClick={onRetry}>{agentCopy.retryThisResponse}</Button>}</AlertDescription></Alert>}
        </BubbleContent>
      </Bubble>
    </MessageContent>
  </Message>
}
