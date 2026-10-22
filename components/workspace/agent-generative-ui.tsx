'use client'

import { Component, useCallback, useMemo, useState, type ReactNode } from 'react'
import { createParser, Renderer, type ActionEvent, type OpenUIError } from '@openuidev/react-lang'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { getAgentUIIssue, type AgentUIIssue } from '@/lib/agent-ui-status'
import { agentUILibrary } from './agent-ui-library'
import { AgentMarkdown } from './agent-markdown'

const finalParser = createParser(agentUILibrary.toJSONSchema(), agentUILibrary.root)

function GenerationError({ issue, onRetry }: { issue: AgentUIIssue; onRetry?: () => void }) {
  return <Alert variant="destructive">
    <AlertTitle>{issue.title}</AlertTitle>
    <AlertDescription>{issue.message}{onRetry && <Button type="button" variant="outline" size="sm" onClick={onRetry}>重试此回复</Button>}</AlertDescription>
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
    return this.props.showErrors ? <GenerationError issue={{ title: '回复显示出错', message: '这条回复中的卡片或表格在显示时发生错误。请重试此回复。' }} onRetry={this.props.onRetry} /> : null
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
  const handleError = useCallback((errors: OpenUIError[]) => {
    if (!isStreaming) setReportedErrors({ response, errors })
  }, [response, isStreaming])
  const issue = useMemo(() => {
    if (isStreaming || !showErrors || !isOpenUI) return null
    try {
      return getAgentUIIssue(finalParser.parse(response), reportedErrors?.response === response ? reportedErrors.errors : [])
    } catch {
      return getAgentUIIssue(null)
    }
  }, [response, isStreaming, showErrors, isOpenUI, reportedErrors])

  if (!isOpenUI) return isStreaming ? null : <AgentMarkdown text={response} />

  return <GenerationBoundary response={response} showErrors={!isStreaming && showErrors} onRetry={onRetry}>
    <Renderer response={response} library={agentUILibrary} isStreaming={isStreaming} onAction={onAction} onError={handleError} publishObservability={false} />
    {issue && <GenerationError issue={issue} onRetry={onRetry} />}
  </GenerationBoundary>
}
