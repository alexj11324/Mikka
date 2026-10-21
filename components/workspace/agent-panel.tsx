'use client'

import '@openuidev/react-ui/layered/styles/index.css'
import { useRef, useState } from 'react'
import useSWR from 'swr'
import { authClient } from '@/lib/auth-client'
import { Button } from '@/components/ui/button'
import type { AgentHistory, SavedAgentSession } from '@/lib/agent-history'
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

async function fetchHistory(url: string): Promise<AgentHistory> {
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error ?? '无法恢复聊天历史。')
  return body
}

export function AgentPanel() {
  const [selection, setSelection] = useState<{ key: string; sessionId?: string; fresh?: boolean }>({ key: 'latest' })
  const query = selection.fresh ? '?new=1' : selection.sessionId ? `?sessionId=${selection.sessionId}` : ''
  const { data: account } = authClient.useSession()
  const userId = account?.user.id
  const { data, error, mutate } = useSWR<AgentHistory>(userId ? [`/api/agent/sessions${query}`, userId] : null, ([url]: [string, string]) => fetchHistory(url), { revalidateOnFocus: false, revalidateOnMount: true })
  if (!data) return <section aria-label="Agent 历史加载" className="flex min-h-64 flex-col items-center justify-center gap-3">
    <p role={error ? 'alert' : 'status'}>{error ? error.message : '正在恢复聊天历史…'}</p>
    {error && <Button variant="outline" onClick={() => { void mutate() }}>重试加载</Button>}
  </section>
  return <AgentSession key={`${userId}:${selection.key}`} initial={data} sessions={data.sessions}
    onSaved={async () => { await mutate() }}
    onSelect={sessionId => setSelection({ key: sessionId, sessionId })}
    onReset={() => setSelection({ key: crypto.randomUUID(), fresh: true })} />
}

type DisplayTurn = { id: string; question: string; completion: string; error?: Error; stopped: boolean }

function AgentSession({ onReset, onSelect, onSaved, initial, sessions }: {
  onReset: () => void; onSelect: (id: string) => void; onSaved: () => Promise<void>; initial: AgentHistory; sessions: SavedAgentSession[]
}) {
  const restored = initial.turns.at(-1)
  const { input: draft, setInput: updateDraft, complete, completion, error, isLoading, stop } = useCompletion({ api: '/api/agent', credentials: 'same-origin', fetch: fetchAgentResponse, initialCompletion: restored?.completion ?? '' })
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const submittingRef = useRef(false)
  const lastRequestRef = useRef<{ prompt: string; failed: boolean } | null>(restored ? { prompt: restored.prompt, failed: restored.status !== 'complete' } : null)
  const sessionIdRef = useRef<string | null>(initial.sessionId)
  const [generation, setGeneration] = useState(restored?.id ?? '')
  const [question, setQuestion] = useState(restored?.prompt ?? '')
  const [stopped, setStopped] = useState(restored?.status === 'stopped' || restored?.status === 'pending')
  const [restoredError, setRestoredError] = useState<Error | undefined>(() => restored && restored.status !== 'complete'
    ? new Error(restored.error ?? '上次回复未完成，已恢复保存的内容；若仍在生成，请稍后重试。') : undefined)
  const [previousTurns, setPreviousTurns] = useState<DisplayTurn[]>(() => initial.turns.slice(0, -1).map(turn => ({
    id: turn.id, question: turn.prompt, completion: turn.completion, error: turn.error ? new Error(turn.error) : undefined,
    stopped: turn.status === 'stopped' || turn.status === 'pending',
  })))

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
      const turnId = retrying && generation ? generation : crypto.randomUUID()
      if (!retrying) {
        if (question) setPreviousTurns(turns => [...turns, { id: generation, question, completion, error: error ?? restoredError, stopped }])
        else setPreviousTurns([])
      }
      setGeneration(turnId)
      setQuestion(prompt.trim())
      setStopped(false)
      setRestoredError(undefined)
      lastRequestRef.current = { prompt: prompt.trim(), failed: true }
      const result = await complete(prompt.trim(), { body: { sessionId: sessionIdRef.current, turnId, retry: Boolean(retrying) } })
      lastRequestRef.current.failed = !result?.trim()
      if (result && source === 'composer') updateDraft(current => current === prompt ? '' : current)
      return Boolean(result?.trim())
    } finally {
      submittingRef.current = false
      void onSaved().catch(() => toast.error('暂时无法刷新会话列表，请刷新页面重试。'))
    }
  }

  return <ThemeProvider cssSelector="#orvilo-agent" lightTheme={agentTheme} darkTheme={agentTheme}>
    <AgentInteractionContext value={{ busy: isLoading, continueFromAnswer: prompt => request(prompt, 'inline') }}>
      <AgentChat
        turns={[
          ...previousTurns.map(turn => ({ id: turn.id, question: turn.question, response: <AgentResponse completion={turn.completion} error={turn.error} stopped={turn.stopped} isLoading={false} onAction={handleUIAction} /> })),
          ...(question ? [{ id: generation, question, response: <AgentResponse completion={completion} error={error ?? restoredError} stopped={stopped} isLoading={isLoading} onAction={handleUIAction} onRetry={() => { if (lastRequestRef.current) lastRequestRef.current.failed = true; void request(question, 'inline') }} /> }] : []),
        ]}
        streaming={isLoading}
        sessions={sessions}
        sessionId={sessionIdRef.current}
        onSelect={onSelect}
        onReset={onReset}
        composer={<AgentComposer ref={inputRef} draft={draft} onChange={updateDraft} onSubmit={() => { void request(draft) }} isLoading={isLoading} onStop={() => { setStopped(true); stop() }} />}
      />
    </AgentInteractionContext>
  </ThemeProvider>
}
