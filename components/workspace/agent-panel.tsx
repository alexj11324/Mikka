'use client'

import '@openuidev/react-ui/layered/styles/index.css'
import { useRef, useState } from 'react'
import type { ActionEvent } from '@openuidev/react-lang'
import { toast } from 'sonner'
import { useCompletion } from '@ai-sdk/react'
import { createTheme, ThemeProvider } from '@openuidev/react-ui/ThemeProvider'
import { AgentComposer } from './agent-composer'
import { AgentStarters } from './agent-starters'
import { AgentResponse } from './agent-response'
import { AgentChat } from './agent-chat'
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
  const sessionIdRef = useRef<string | null>(null)
  const [generation, setGeneration] = useState(0)
  const [question, setQuestion] = useState('')

  function handleUIAction(event: ActionEvent) {
    if (isLoading) return
    if (event.type !== 'continue_conversation') {
      toast.info('当前界面只支持填入提问，不会打开外部链接或修改工作区。')
      return
    }
    const context = typeof event.params.context === 'string' ? event.params.context : ''
    const form = event.formState && Object.keys(event.formState).length > 0 ? `\n表单内容：${JSON.stringify(event.formState)}` : ''
    const prompt = [event.humanFriendlyMessage, context, form].filter(Boolean).join('\n')
    updateDraft(prompt.slice(0, 8000))
    inputRef.current?.focus()
    toast.info('已填入提问，请确认内容后发送。')
  }

  function selectStarter(prompt: string) {
    if (isLoading) return
    updateDraft(prompt)
    inputRef.current?.focus()
  }

  async function submit() {
    if (!draft.trim() || isLoading || submittingRef.current) return
    submittingRef.current = true
    try {
      sessionIdRef.current ??= crypto.randomUUID()
      setGeneration(value => value + 1)
      setQuestion(draft.trim())
      await complete(draft.trim(), { body: { sessionId: sessionIdRef.current } })
    } finally {
      submittingRef.current = false
    }
  }

  return <ThemeProvider cssSelector="#orvilo-agent" lightTheme={agentTheme} darkTheme={agentTheme}>
    <AgentChat
      question={question}
      streaming={isLoading}
      onReset={onReset}
      composer={<AgentComposer ref={inputRef} draft={draft} onChange={updateDraft} onSubmit={submit} isLoading={isLoading} onStop={stop} />}
      response={<AgentResponse key={generation} completion={completion} error={error} isLoading={isLoading} onAction={handleUIAction} />}
      starters={<AgentStarters onSelect={selectStarter} />}
    />
  </ThemeProvider>
}
