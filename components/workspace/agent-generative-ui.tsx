'use client'

import { Component, useCallback, useState, type ReactNode } from 'react'
import { Renderer, type ActionEvent, type OpenUIError, type ParseResult } from '@openuidev/react-lang'
import { agentUILibrary } from './agent-ui-library'

function GenerationError() {
  return <p role="alert" className="text-sm text-destructive">界面未能完整生成，请重新发送或简化问题。尚未保存或执行任何工作区操作。</p>
}

class GenerationBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() { return { failed: true } }

  render() { return this.state.failed ? <GenerationError /> : this.props.children }
}

export function AgentGenerativeUI({ response, isStreaming, onAction }: {
  response: string
  isStreaming: boolean
  onAction: (event: ActionEvent) => void
}) {
  const [hasErrors, setHasErrors] = useState(false)
  const [incomplete, setIncomplete] = useState(false)
  const handleError = useCallback((errors: OpenUIError[]) => setHasErrors(errors.some(error => error.severity !== 'warning')), [])
  const handleParse = useCallback((result: ParseResult | null) => setIncomplete(!result?.root || result.meta.incomplete || result.meta.unresolved.length > 0), [])
  const isOpenUI = /(?:^|\n)\s*root\s*=/.test(response)

  if (!isOpenUI) return isStreaming ? null : <p className="whitespace-pre-wrap text-sm leading-relaxed">{response}</p>

  return <GenerationBoundary>
    <Renderer response={response} library={agentUILibrary} isStreaming={isStreaming} onAction={onAction} onError={handleError} onParseResult={handleParse} publishObservability={false} />
    {!isStreaming && (hasErrors || incomplete) && <GenerationError />}
  </GenerationBoundary>
}
