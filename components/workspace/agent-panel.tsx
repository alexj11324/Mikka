'use client'

import '@openuidev/react-ui/layered/styles/index.css'
import { useRef, useState } from 'react'
import useSWR from 'swr'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import type { AgentHistory } from '@/lib/agent-history'
import type { ActionEvent } from '@openuidev/react-lang'
import { toast } from 'sonner'
import { useCompletion } from '@ai-sdk/react'
import { createTheme, ThemeProvider } from '@openuidev/react-ui/ThemeProvider'
import { AgentComposer } from './agent-composer'
import { AgentResponse } from './agent-response'
import { AgentChat, type AgentChatSession } from './agent-chat'
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

export function AgentPanel({ userId, initialHistory }: { userId: string; initialHistory?: AgentHistory }) {
  const latest = useSWR<AgentHistory>(['/api/agent/sessions', userId], ([url]: [string, string]) => fetchHistory(url), {
    fallbackData: initialHistory, revalidateOnFocus: false, revalidateOnMount: !initialHistory,
  })
  if (!latest.data) return <AgentHistoryLoading error={latest.error} onRetry={() => { void latest.mutate() }} />
  return <ThemeProvider cssSelector=".orvilo-agent" lightTheme={agentTheme} darkTheme={agentTheme}>
    <AgentSessions userId={userId} initial={latest.data} onSaved={async () => { await latest.mutate() }} />
  </ThemeProvider>
}

function AgentHistoryLoading({ error, onRetry }: { error?: Error; onRetry: () => void }) {
  return <section aria-label="Agent 对话工作区" aria-busy={!error} className="flex h-[calc(100svh-4rem)] flex-col gap-4 p-4">
    {error ? <><p role="alert">聊天记录加载失败。</p><Button variant="outline" onClick={onRetry}>重试</Button></> : <><Skeleton className="h-14 w-full" /><Skeleton className="h-20 w-2/3" /><Skeleton className="mt-auto h-24 w-full" /></>}
  </section>
}

type OpenSession = { key: string; initial?: AgentHistory; sessionId?: string }
type LiveSession = AgentChatSession & { key: string }

function AgentSessions({ userId, initial, onSaved }: { userId: string; initial: AgentHistory; onSaved: () => Promise<void> }) {
  const [opened, setOpened] = useState<OpenSession[]>([{ key: initial.sessionId ?? 'new', initial }])
  const [activeKey, setActiveKey] = useState(initial.sessionId ?? 'new')
  const [live, setLive] = useState<Record<string, LiveSession>>({})
  const sessions = new Map<string, AgentChatSession>(initial.sessions.map(session => [session.id, session]))
  for (const session of Object.values(live)) sessions.set(session.id, session)
  const history = [...sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  function select(sessionId: string) {
    const existing = opened.find(entry => (live[entry.key]?.id ?? entry.sessionId ?? entry.initial?.sessionId) === sessionId)
    if (existing) { setActiveKey(existing.key); return }
    setOpened(entries => [...entries, { key: sessionId, sessionId }])
    setActiveKey(sessionId)
  }

  function reset() {
    const key = crypto.randomUUID()
    setOpened(entries => [...entries, { key, initial: { sessions: [], sessionId: null, turns: [] } }])
    setActiveKey(key)
  }

  return opened.map(entry => <div key={entry.key} hidden={entry.key !== activeKey} className="h-full min-h-0">
    <AgentSessionLoader entry={entry} userId={userId} sessions={history} onSelect={select} onReset={reset} onSaved={onSaved}
      onState={session => setLive(current => ({ ...current, [entry.key]: { ...session, key: entry.key } }))} />
  </div>)
}

function AgentSessionLoader({ entry, userId, ...props }: Omit<AgentSessionProps, 'initial' | 'completionId'> & { entry: OpenSession; userId: string }) {
  const selected = useSWR<AgentHistory>(!entry.initial && entry.sessionId ? [`/api/agent/sessions?sessionId=${entry.sessionId}`, userId] : null,
    ([url]: [string, string]) => fetchHistory(url), { revalidateOnFocus: false, revalidateIfStale: false })
  const data = entry.initial ?? selected.data
  if (!data) return <AgentHistoryLoading error={selected.error} onRetry={() => { void selected.mutate() }} />
  return <AgentSession {...props} initial={data} completionId={`${userId}:${entry.key}`} />
}

type DisplayTurn = { id: string; question: string; completion: string; error?: Error; stopped: boolean }
type AgentSessionProps = {
  onReset: () => void; onSelect: (id: string) => void; onSaved: () => Promise<void>; initial: AgentHistory; sessions: AgentChatSession[]
  completionId: string; onState: (session: AgentChatSession) => void
}

function AgentSession({ onReset, onSelect, onSaved, onState, initial, sessions, completionId }: AgentSessionProps) {
  const restored = initial.turns.at(-1)
  const { input: draft, setInput: updateDraft, complete, completion, error, isLoading, stop } = useCompletion({ id: completionId, api: '/api/agent', credentials: 'same-origin', fetch: fetchAgentResponse, initialCompletion: restored?.completion ?? '' })
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const submittingRef = useRef(false)
  const lastRequestRef = useRef<{ prompt: string; failed: boolean } | null>(restored ? { prompt: restored.prompt, failed: restored.status !== 'complete' } : null)
  const sessionIdRef = useRef<string | null>(initial.sessionId)
  const titleRef = useRef(initial.sessions.find(session => session.id === initial.sessionId)?.title ?? initial.turns[0]?.prompt)
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
      titleRef.current ??= prompt.trim().slice(0, 200)
      onState({ id: sessionIdRef.current, title: titleRef.current, updatedAt: new Date().toISOString(), running: true })
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
      if (sessionIdRef.current && titleRef.current) onState({ id: sessionIdRef.current, title: titleRef.current, updatedAt: new Date().toISOString(), running: false })
      void onSaved().catch(() => toast.error('暂时无法刷新会话列表，请刷新页面重试。'))
    }
  }

  return <AgentInteractionContext value={{ busy: isLoading, continueFromAnswer: prompt => request(prompt, 'inline') }}>
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
        onSuggestion={prompt => { updateDraft(prompt); inputRef.current?.focus() }}
        composer={<AgentComposer ref={inputRef} isEmpty={!question} draft={draft} onChange={updateDraft} onSubmit={() => { void request(draft) }} isLoading={isLoading} onStop={() => { setStopped(true); stop() }} />}
      />
    </AgentInteractionContext>
}
