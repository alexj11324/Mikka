'use client'

import { useAgentCopy } from '@/hooks/use-agent-copy'
import { fetchAgentHistory as fetchHistory, useAgentHistory } from '@/hooks/use-agent-history'
import { useEffect, useRef, useState } from 'react'
import useSWR from 'swr'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import type { AgentHistory } from '@/lib/agent-history'
import type { ActionEvent } from '@openuidev/react-lang'
import { toast } from 'sonner'
import { useCompletion } from '@ai-sdk/react'
import { AgentComposer } from './agent-composer'
import { AgentThemeProvider } from './agent-theme'
import dynamic from 'next/dynamic'

import { AgentResponse } from './agent-response'
import { AgentChat, type AgentChatSession } from './agent-chat'
import { AgentInteractionContext } from './agent-interaction'
import { ComputerConversation } from '@/components/computer/computer-agents'
import { fetchAgentResponse, observeAgentImages } from '@/lib/agent-fetch'
import { preloadAgentImage } from '@/lib/agent-image-loader'
import { withBasePath } from '@/lib/base-path'

const AgentDemo = dynamic(() => import('./agent-demo').then(module => module.AgentDemo))

const fetchAgentWithImages: typeof fetch = async (input, options) => {
  const response = await fetchAgentResponse(input, options)
  if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return response
  return new Response(response.body.pipeThrough(observeAgentImages(preloadAgentImage)), {
    status: response.status, statusText: response.statusText, headers: response.headers,
  })
}


/** `request` opens a session from outside (the conversation list): a session id, or null for a new conversation. */
export type AgentSessionRequest = { sessionId: string | null; nonce: number }

export function AgentPanel({ userId, initialHistory, request, onActive, onSessions }: { userId: string; initialHistory?: AgentHistory; request?: AgentSessionRequest; onActive?: (sessionId: string | null) => void; onSessions?: (sessions: AgentChatSession[]) => void }) {
  const [demo, setDemo] = useState(false)
  const latest = useAgentHistory(userId, initialHistory)
  if (!latest.data) return <AgentHistoryLoading error={latest.error} onRetry={() => { void latest.mutate() }} />
  return <AgentThemeProvider>
    <div hidden={demo} className="h-full min-h-0"><AgentSessions userId={userId} initial={latest.data} request={request} onActive={onActive} onSessions={onSessions} onDemo={() => setDemo(true)} onSaved={async () => { await latest.mutate() }} /></div>
    {demo && <AgentDemo onClose={() => setDemo(false)} />}
  </AgentThemeProvider>
}

function AgentHistoryLoading({ error, onRetry }: { error?: Error; onRetry: () => void }) {
  const agentCopy = useAgentCopy()

  return <section aria-label={agentCopy.agentConversationWorkspace} aria-busy={!error} className="flex h-full min-h-0 flex-col gap-4 p-4">
    {error ? <><p role="alert">{agentCopy.chatHistoryFailedToLoad}</p><Button variant="outline" onClick={onRetry}>{agentCopy.retry}</Button></> : <><Skeleton className="h-14 w-full" /><Skeleton className="h-20 w-2/3" /><Skeleton className="mt-auto h-24 w-full" /></>}
  </section>
}

type OpenSession = { key: string; initial?: AgentHistory; sessionId?: string }
type LiveSession = AgentChatSession & { key: string }

function AgentSessions({ userId, initial, request, onActive, onSessions, onSaved, onDemo }: { userId: string; initial: AgentHistory; request?: AgentSessionRequest; onActive?: (sessionId: string | null) => void; onSessions?: (sessions: AgentChatSession[]) => void; onSaved: () => Promise<void>; onDemo: () => void }) {
  const firstKey = request ? request.sessionId ?? `new-${request.nonce}` : initial.sessionId ?? 'new'
  const [opened, setOpened] = useState<OpenSession[]>(() => [request && request.sessionId !== initial.sessionId ? (request.sessionId ? { key: firstKey, sessionId: request.sessionId } : { key: firstKey, initial: { sessions: [], sessionId: null, turns: [] } }) : { key: firstKey, initial }])
  const [activeKey, setActiveKey] = useState(firstKey)
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

  const handled = useRef(request?.nonce)
  useEffect(() => {
    if (!request || handled.current === request.nonce) return
    handled.current = request.nonce
    if (request.sessionId) select(request.sessionId)
    else reset()
  })
  const activeEntry = opened.find(entry => entry.key === activeKey)
  const activeId = activeEntry ? live[activeEntry.key]?.id ?? activeEntry.sessionId ?? activeEntry.initial?.sessionId ?? null : null
  useEffect(() => { onActive?.(activeId) }, [activeId, onActive])
  // The conversation list lives outside this panel; it also needs sessions that are still streaming and not saved yet.
  const historyKey = history.map(session => `${session.id}:${session.updatedAt}:${session.title}:${session.running ? 1 : 0}`).join('|')
  const historyRef = useRef(history)
  useEffect(() => { historyRef.current = history })
  useEffect(() => { onSessions?.(historyRef.current) }, [historyKey, onSessions])
  useEffect(() => () => onSessions?.([]), [onSessions])

  return opened.map(entry => <div key={entry.key} hidden={entry.key !== activeKey} className="h-full min-h-0">
    <AgentSessionLoader entry={entry} userId={userId} sessions={history} onSelect={select} onReset={reset} onSaved={onSaved} onDemo={onDemo}
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
  onReset: () => void; onSelect: (id: string) => void; onSaved: () => Promise<void>; onDemo: () => void; initial: AgentHistory; sessions: AgentChatSession[]
  completionId: string; onState: (session: AgentChatSession) => void
}

function AgentSession({ onReset, onSelect, onSaved, onState, onDemo, initial, sessions, completionId }: AgentSessionProps) {
  const agentCopy = useAgentCopy()

  const restored = initial.turns.at(-1)
  const { input: draft, setInput: updateDraft, complete, completion, error, isLoading, stop } = useCompletion({ id: completionId, api: withBasePath('/api/agent'), credentials: 'same-origin', fetch: fetchAgentWithImages, initialCompletion: restored?.completion ?? '' })
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const submittingRef = useRef(false)
  const lastRequestRef = useRef<{ prompt: string; failed: boolean } | null>(restored ? { prompt: restored.prompt, failed: restored.status !== 'complete' } : null)
  const sessionIdRef = useRef<string | null>(initial.sessionId)
  const titleRef = useRef(initial.sessions.find(session => session.id === initial.sessionId)?.title ?? initial.turns[0]?.prompt)
  const [generation, setGeneration] = useState(restored?.id ?? '')
  const [question, setQuestion] = useState(restored?.prompt ?? '')
  const [stopped, setStopped] = useState(restored?.status === 'stopped' || restored?.status === 'pending')
  const [restoredError, setRestoredError] = useState<Error | undefined>(() => restored && restored.status !== 'complete'
    ? new Error(restored.error ?? agentCopy.thePreviousResponseDidNotFinishSaved) : undefined)
  const [previousTurns, setPreviousTurns] = useState<DisplayTurn[]>(() => initial.turns.slice(0, -1).map(turn => ({
    id: turn.id, question: turn.prompt, completion: turn.completion, error: turn.error ? new Error(turn.error) : undefined,
    stopped: turn.status === 'stopped' || turn.status === 'pending',
  })))

  async function handleUIAction(event: ActionEvent) {
    if (isLoading || submittingRef.current) return
    if (event.type !== 'continue_conversation') {
      toast.info(agentCopy.thisInterfaceOnlyContinuesTheConversationIt)
      return
    }
    const context = typeof event.params.context === 'string' ? event.params.context : ''
    const form = event.formState && Object.keys(event.formState).length > 0 ? (agentCopy.formContent + (JSON.stringify(event.formState))) : ''
    const prompt = [event.humanFriendlyMessage, context, form].filter(Boolean).join('\n')
    if (!prompt.trim() || prompt.length > 8000) {
      toast.error(agentCopy.theQuestionIsEmptyOrTooLong)
      return
    }
    if (!await request(prompt, 'inline')) toast.error(agentCopy.theQuestionDidNotFinishRetryIn)
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
      void onSaved().catch(() => toast.error(agentCopy.unableToRefreshConversationsPleaseReloadThe))
    }
  }

  return <AgentInteractionContext value={{ busy: isLoading, continueFromAnswer: prompt => request(prompt, 'inline') }}><ComputerConversation id={sessionIdRef.current}>
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
        onDemo={onDemo}
        onSuggestion={prompt => { updateDraft(prompt); inputRef.current?.focus() }}
        composer={<AgentComposer ref={inputRef} isEmpty={!question} draft={draft} onChange={updateDraft} onSubmit={() => { void request(draft) }} isLoading={isLoading} onStop={() => { setStopped(true); stop() }} />}
      />
    </ComputerConversation></AgentInteractionContext>
}
