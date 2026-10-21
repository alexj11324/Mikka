'use client'

import '@openuidev/react-ui/layered/styles/button.css'
import '@openuidev/react-ui/layered/styles/card.css'
import '@openuidev/react-ui/layered/styles/textArea.css'
import { useRef } from 'react'
import { useCompletion } from '@ai-sdk/react'
import { createTheme, ThemeProvider } from '@openuidev/react-ui/ThemeProvider'
import { AgentComposer } from './agent-composer'
import { AgentStarters } from './agent-starters'
import { AgentResponse } from './agent-response'

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
  const { input: draft, setInput: updateDraft, complete, completion, error, isLoading, stop } = useCompletion({ api: '/api/agent', credentials: 'same-origin' })
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const submittingRef = useRef(false)

  function selectStarter(prompt: string) {
    if (isLoading) return
    updateDraft(prompt)
    inputRef.current?.focus()
  }

  async function submit() {
    if (!draft.trim() || isLoading || submittingRef.current) return
    submittingRef.current = true
    try {
      await complete(draft.trim())
    } finally {
      submittingRef.current = false
    }
  }

  return <section id="orvilo-agent" aria-labelledby="agent-title" className="flex min-h-[calc(100svh-4rem)] w-full flex-col px-4 py-8 sm:px-8">
    <ThemeProvider cssSelector="#orvilo-agent" lightTheme={agentTheme} darkTheme={agentTheme}>
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-8 py-12 sm:py-20">
        <header className="flex flex-col gap-3 text-center">
          <h1 id="agent-title" className="text-2xl font-medium tracking-tight sm:text-3xl">有什么可以帮你？</h1>
          <p className="text-sm text-muted-foreground">从一个想法开始，和 Agent 一起理清下一步。</p>
        </header>
        <AgentComposer ref={inputRef} draft={draft} onChange={updateDraft} onSubmit={submit} isLoading={isLoading} onStop={stop} />
        <AgentResponse completion={completion} error={error} isLoading={isLoading} />
        {!isLoading && <AgentStarters onSelect={selectStarter} />}
        <p id="agent-service-note" className="text-center text-xs text-muted-foreground">OpenCode Zen · 单次问答，不保存历史，也不会读取或修改工作区数据。</p>
      </div>
    </ThemeProvider>
  </section>
}
