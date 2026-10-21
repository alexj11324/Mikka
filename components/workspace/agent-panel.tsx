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
  const sessionIdRef = useRef<string | null>(null)
  const [generation, setGeneration] = useState(0)

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
      await complete(draft.trim(), { body: { sessionId: sessionIdRef.current } })
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
        <AgentResponse key={generation} completion={completion} error={error} isLoading={isLoading} onAction={handleUIAction} />
        {!isLoading && <AgentStarters onSelect={selectStarter} />}
        <p id="agent-service-note" className="text-center text-xs text-muted-foreground">OpenCode Go · GLM-5.3-Flash · OpenUI 生成界面。单次问答，不保存历史，不读取或修改工作区；界面按钮仅填入提问。</p>
      </div>
    </ThemeProvider>
  </section>
}
