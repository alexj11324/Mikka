'use client'

import '@openuidev/react-ui/layered/styles/index.css'
import { useRef, useState } from 'react'
import type { ActionEvent } from '@openuidev/react-lang'
import { toast } from 'sonner'
import { useCompletion } from '@ai-sdk/react'
import { createTheme, ThemeProvider } from '@openuidev/react-ui/ThemeProvider'
import { AgentComposer } from './agent-composer'
import { AgentResponse } from './agent-response'
import { AgentChat } from './agent-chat'
import { AgentInteractionContext } from './agent-interaction'
import { fetchAgentResponse } from '@/lib/agent-fetch'

const agentTheme = createTheme({
  background: 'var(--background)',
  foreground: 'var(--background)',
  sunk: 'var(--muted)',
  highlightSubtle: 'var(--background)',
  highlight: 'var(--accent)',
  textNeutralPrimary: 'var(--foreground)',
  textNeutralSecondary: 'var(--muted-foreground)',
  textNeutralTertiary: 'var(--muted-foreground)',
  textAccentPrimary: 'var(--primary-foreground)',
  interactiveAccentDefault: 'var(--primary)',
  interactiveAccentHover: 'var(--primary)',
  interactiveAccentDisabled: 'var(--muted)',
  borderDefault: 'var(--border)',
  borderInteractive: 'var(--input)',
  borderInteractiveEmphasis: 'var(--ring)',
  borderAccent: 'var(--primary)',
  fontBody: 'var(--font-sans)',
  fontHeading: 'var(--font-sans)',
  fontLabel: 'var(--font-sans)',
})

export function AgentPanel() {
  const [sessionVersion, setSessionVersion] = useState(0)
  return <AgentSession key={sessionVersion} onReset={() => setSessionVersion(value => value + 1)} />
}

function AgentSession({ onReset }: { onReset: () => void }) {
  const { input: draft, setInput: updateDraft, complete, completion, error, isLoading, stop } = useCompletion({ api: '/api/agent', credentials: 'same-origin', fetch: fetchAgentResponse })
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const submittingRef = useRef(false)
  const lastRequestRef = useRef<{ prompt: string; failed: boolean } | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const [generation, setGeneration] = useState(0)
  const [question, setQuestion] = useState('')
  const [stopped, setStopped] = useState(false)
  const [previousTurns, setPreviousTurns] = useState<{ id: number; question: string; completion: string; error?: Error; stopped: boolean }[]>([])

  async function handleUIAction(event: ActionEvent) {
    if (isLoading || submittingRef.current) return
    if (event.type !== 'continue_conversation') {
      toast.info('当前界面只支持直接继续对话，不会打开外部链接或修改工作区。')
      return
    }
    const context = typeof event.params.context === 'string' ? event.params.context : ''
    const form = event.formState && Object.keys(event.formState).length > 0 ? `表单内容：${JSON.stringify(event.formState)}` : ''
    const prompt = [event.humanFriendlyMessage, context, form].filter(Boolean).join('\n')
    if (!prompt.trim() || prompt.length > 8000) {
      toast.error('提问内容为空或过长，请在原组件中调整后重试。')
      return
    }
    if (!await request(prompt, 'inline')) toast.error('本次提问未完成，请在原组件中重试。')
  }

  async function request(prompt: string, source: 'composer' | 'inline' = 'composer') {
    if (!prompt.trim() || prompt.length > 8000 || isLoading || submittingRef.current) return false
    submittingRef.current = true
    try {
      sessionIdRef.current ??= crypto.randomUUID()
      const retrying = lastRequestRef.current?.failed && lastRequestRef.current.prompt === prompt.trim()
      if (!retrying) {
        if (question) setPreviousTurns(turns => [...turns, { id: generation, question, completion, error, stopped }])
        else setPreviousTurns([])
        setGeneration(value => value + 1)
      }
      setQuestion(prompt.trim())
      setStopped(false)
      lastRequestRef.current = { prompt: prompt.trim(), failed: true }
      const result = await complete(prompt.trim(), { body: { sessionId: sessionIdRef.current } })
      lastRequestRef.current.failed = !result?.trim()
      if (result && source === 'composer') updateDraft(current => current === prompt ? '' : current)
      return Boolean(result?.trim())
    } finally {
      submittingRef.current = false
    }
  }

  return <ThemeProvider cssSelector="#orvilo-agent" lightTheme={agentTheme} darkTheme={agentTheme}>
    <AgentInteractionContext value={{ busy: isLoading, continueFromAnswer: prompt => request(prompt, 'inline') }}>
      <AgentChat
        turns={[
          ...previousTurns.map(turn => ({ id: turn.id, question: turn.question, response: <AgentResponse completion={turn.completion} error={turn.error} stopped={turn.stopped} isLoading={false} onAction={handleUIAction} /> })),
          ...(question ? [{ id: generation, question, response: <AgentResponse completion={completion} error={error} stopped={stopped} isLoading={isLoading} onAction={handleUIAction} onRetry={() => { if (lastRequestRef.current) lastRequestRef.current.failed = true; void request(question, 'inline') }} /> }] : []),
        ]}
        streaming={isLoading}
        onReset={onReset}
        composer={<AgentComposer ref={inputRef} draft={draft} onChange={updateDraft} onSubmit={() => { void request(draft) }} isLoading={isLoading} onStop={() => { setStopped(true); stop() }} />}
      />
    </AgentInteractionContext>
  </ThemeProvider>
}
