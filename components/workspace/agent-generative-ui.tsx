'use client'

import { useAgentCopy } from '@/hooks/use-agent-copy'
import { defaultAgentCopy as agentCopy } from '@/lib/agent-copy'
import { Component, useCallback, useMemo, useState, type ReactNode } from 'react'
import { createParser, Renderer, type ActionEvent, type OpenUIError } from '@openuidev/react-lang'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { getAgentUIIssue, type AgentUIIssue } from '@/lib/agent-ui-status'
import { detectAgentUISource } from '@/lib/agent-ui-source'
import { agentUILibrary } from './agent-ui-library'
import { AgentMarkdown } from './agent-markdown'
import { AgentTextBubble } from './agent-text-bubble'

const finalParser = createParser(agentUILibrary.toJSONSchema(), agentUILibrary.root)

function GenerationError({ issue, onRetry }: { issue: AgentUIIssue; onRetry?: () => void }) {
  const agentCopy = useAgentCopy()

  return <Alert variant="destructive">
    <AlertTitle>{issue.title}</AlertTitle>
    <AlertDescription>{issue.message}{onRetry && <Button type="button" variant="outline" size="sm" onClick={onRetry}>{agentCopy.retryThisResponse}</Button>}</AlertDescription>
  </Alert>
}

type BoundaryProps = { children: ReactNode; response: string; showErrors: boolean; onRetry?: () => void; fallback?: ReactNode }

class GenerationBoundary extends Component<BoundaryProps, { failed: boolean; response: string }> {
  state = { failed: false, response: this.props.response }

  static getDerivedStateFromProps(props: BoundaryProps, state: { response: string }) {
    return props.response === state.response ? null : { failed: false, response: props.response }
  }

  static getDerivedStateFromError() { return { failed: true } }

  render() {
    if (!this.state.failed) return this.props.children
    if (this.props.showErrors) return <GenerationError issue={{ title: agentCopy.unableToDisplayResponse, message: agentCopy.aCardOrTableInThisResponse }} onRetry={this.props.onRetry} />
    return this.props.fallback ?? null
  }
}

export function AgentGenerativeUI({ response, isStreaming, onAction, showErrors = true, onRetry }: {
  response: string
  isStreaming: boolean
  onAction: (event: ActionEvent) => void
  showErrors?: boolean
  onRetry?: () => void
}) {
  const [reportedErrors, setReportedErrors] = useState<{ response: string; errors: OpenUIError[] } | null>(null)
  const detected = useMemo(() => detectAgentUISource(response), [response])
  const isOpenUI = detected.isOpenUI
  const normalizedResponse = detected.source
  const handleError = useCallback((errors: OpenUIError[]) => {
    if (!isStreaming) setReportedErrors({ response, errors })
  }, [response, isStreaming])
  const issue = useMemo(() => {
    if (isStreaming || !isOpenUI) return null
    try {
      return getAgentUIIssue(finalParser.parse(normalizedResponse), reportedErrors?.response === response ? reportedErrors.errors : [])
    } catch {
      return getAgentUIIssue(null)
    }
  }, [response, normalizedResponse, isStreaming, isOpenUI, reportedErrors])

  if (!isOpenUI) return isStreaming ? null : <AgentTextBubble><AgentMarkdown text={response} /></AgentTextBubble>

  // A detected card that cannot be read must never show its source as text: say
  // so quietly where errors are hidden (the Coordinator chat), never blank.
  const hiddenError = !isStreaming && !showErrors && issue
    ? <AgentTextBubble><p className="text-sm leading-7">{issue.message}</p></AgentTextBubble>
    : null
  const boundaryFallback = !isStreaming && !showErrors && !issue
    ? <AgentTextBubble><p className="text-sm leading-7">{agentCopy.theModelReturnedAnInvalidFormatThis}</p></AgentTextBubble>
    : undefined

  return <>
    <GenerationBoundary response={response} showErrors={!isStreaming && showErrors} onRetry={onRetry} fallback={boundaryFallback}>
      <Renderer response={normalizedResponse} library={agentUILibrary} isStreaming={isStreaming} onAction={onAction} onError={handleError} publishObservability={false} />
      {issue && showErrors && <GenerationError issue={issue} onRetry={onRetry} />}
    </GenerationBoundary>
    {hiddenError}
  </>
}
