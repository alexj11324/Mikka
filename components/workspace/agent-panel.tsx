'use client'

import '@openuidev/react-ui/layered/styles/button.css'
import '@openuidev/react-ui/layered/styles/card.css'
import '@openuidev/react-ui/layered/styles/textArea.css'
import { useRef, useState } from 'react'
import { createTheme, ThemeProvider } from '@openuidev/react-ui/ThemeProvider'
import { AgentComposer } from './agent-composer'
import { AgentStarters } from './agent-starters'

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
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  function updateDraft(value: string) {
    setDraft(value)
    setNotice('')
  }

  function selectStarter(prompt: string) {
    updateDraft(prompt)
    inputRef.current?.focus()
  }

  function submit() {
    if (!draft.trim()) return
    setNotice('尚未连接模型服务，消息未发送。你的输入已保留。')
  }

  return <section id="orvilo-agent" aria-labelledby="agent-title" className="flex min-h-[calc(100svh-4rem)] w-full flex-col px-4 py-8 sm:px-8">
    <ThemeProvider cssSelector="#orvilo-agent" lightTheme={agentTheme} darkTheme={agentTheme}>
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-8 py-12 sm:py-20">
        <header className="flex flex-col gap-3 text-center">
          <h1 id="agent-title" className="text-2xl font-medium tracking-tight sm:text-3xl">有什么可以帮你？</h1>
          <p className="text-sm text-muted-foreground">从一个想法开始，和 Agent 一起理清下一步。</p>
        </header>
        <AgentComposer ref={inputRef} draft={draft} onChange={updateDraft} onSubmit={submit} />
        <AgentStarters onSelect={selectStarter} />
        <div className="flex flex-col gap-2 text-center text-xs text-muted-foreground">
          {notice && <p role="status">{notice}</p>}
          <p id="agent-service-note">当前仅接入 OpenUI 界面组件，尚未连接模型服务。</p>
        </div>
      </div>
    </ThemeProvider>
  </section>
}
