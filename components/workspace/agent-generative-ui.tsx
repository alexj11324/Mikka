'use client'

import { useAgentCopy } from '@/hooks/use-agent-copy'
import { defaultAgentCopy as agentCopy } from '@/lib/agent-copy'
import { Component, useCallback, useMemo, useState, type ReactNode } from 'react'
import { createParser, Renderer, type ActionEvent, type OpenUIError } from '@openuidev/react-lang'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { getAgentUIIssue, type AgentUIIssue } from '@/lib/agent-ui-status'
import { normalizeAgentUISource } from '@/lib/agent-ui-source'
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

type BoundaryProps = { children: ReactNode; response: string; showErrors: boolean; onRetry?: () => void }

class GenerationBoundary extends Component<BoundaryProps, { failed: boolean; response: string }> {
  state = { failed: false, response: this.props.response }

  static getDerivedStateFromProps(props: BoundaryProps, state: { response: string }) {
    return props.response === state.response ? null : { failed: false, response: props.response }
  }

  static getDerivedStateFromError() { return { failed: true } }

  render() {
    if (!this.state.failed) return this.props.children
    return this.props.showErrors ? <GenerationError issue={{ title: agentCopy.unableToDisplayResponse, message: agentCopy.aCardOrTableInThisResponse }} onRetry={this.props.onRetry} /> : null
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
  const isOpenUI = /(?:^|\n)\s*root\s*=/.test(response)
  const normalizedResponse = useMemo(() => isOpenUI ? normalizeAgentUISource(response) : response, [response, isOpenUI])
  const handleError = useCallback((errors: OpenUIError[]) => {
    if (!isStreaming) setReportedErrors({ response, errors })
  }, [response, isStreaming])
  const issue = useMemo(() => {
    if (isStreaming || !showErrors || !isOpenUI) return null
    try {
      return getAgentUIIssue(finalParser.parse(normalizedResponse), reportedErrors?.response === response ? reportedErrors.errors : [])
    } catch {
      return getAgentUIIssue(null)
    }
  }, [response, normalizedResponse, isStreaming, showErrors, isOpenUI, reportedErrors])

  if (!isOpenUI) return isStreaming ? null : <AgentTextBubble><AgentMarkdown text={response} /></AgentTextBubble>

  return <GenerationBoundary response={response} showErrors={!isStreaming && showErrors} onRetry={onRetry}>
    <Renderer response={normalizedResponse} library={agentUILibrary} isStreaming={isStreaming} onAction={onAction} onError={handleError} publishObservability={false} />
    {issue && <GenerationError issue={issue} onRetry={onRetry} />}
  </GenerationBoundary>
}
