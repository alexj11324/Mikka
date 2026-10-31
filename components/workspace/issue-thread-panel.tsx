'use client'

import { PersonAvatar } from '@/components/person-avatar'
import { useEffect, useRef, useState } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { getIssueThread, sendIssueThreadMessage, stopRun } from '@/app/actions/agents'
import { runIsActive, runStopTimeoutRemaining, threadItems } from '@/lib/issue-run-conversation'
import { threadQuestionView, type IssueThread } from '@/lib/issue-threads'
import { ChatComposer } from '@/components/coordinator/chat-composer'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { AgentMarkdown } from './agent-markdown'
import { ComputerCard } from '@/components/computer/computer-card'
import { ThreadStatus, harnessLabel } from './issue-threads'
import { ThreadStatusIcon } from './thread-status-icon'
import { cn } from '@/lib/utils'
import dynamic from 'next/dynamic'
import { listRunArtifacts } from '@/app/actions/artifacts'
import { ArtifactIcon } from '@/components/icons/artifact-icon'
import { ArtifactKindIcon } from '@/components/artifacts/artifact-card'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

// Loaded on demand: the window itself shows this panel, bare, on its right.
const ArtifactWindow = dynamic(() => import('@/components/artifacts/artifact-window').then(module => module.ArtifactWindow), { ssr: false })
import { ThreadFeedback } from './self-improvement'
import { InlineLoadError } from '@/components/load-error'
import { FieldError } from '@/components/ui/field'

const BUBBLE = 'max-w-[85%] rounded-2xl bg-muted px-3.5 py-2 text-sm whitespace-pre-wrap break-words'

/**
 * An open thread: a conversation between people and the agent running it (R-62, R-10).
 * On the issue page it sits on the right with a close button; opened from a chat's thread
 * card it fills the centre column and `back` names the chat it returns to (R-66).
 */
type IssueThreadPanelProps = { issueId: string; runId: string; onClose: () => void; back?: string; /** Inside the Artifact window: no header, the window has its own. */ bare?: boolean }

export function IssueThreadPanel(props: IssueThreadPanelProps) {
  // Drafts, in-flight callbacks and retry deadlines belong to exactly one run.
  return <ThreadPanel key={props.runId} {...props} />
}

function ThreadPanel({ issueId, runId, onClose, back, bare = false }: IssueThreadPanelProps) {
  const t = useTranslations('IssueThreads')
  const format = useFormatter()
  const { mutate: mutateCache } = useSWRConfig()
  const questionPolls = useRef(0)
  const { data, error, mutate } = useSWR(['issue-thread', issueId, runId], () => getIssueThread(issueId, runId), {
    // A question changes only when it is answered or its continuation starts: back off, capped.
    refreshInterval: detail => !detail ? 0 : runIsActive(threadQuestionView(detail.thread).status) ? 2000 : threadQuestionView(detail.thread).question ? Math.min(2000 * 2 ** questionPolls.current, 30_000) : 0,
    onSuccess: detail => { questionPolls.current = threadQuestionView(detail.thread).question ? questionPolls.current + 1 : 0 },
    revalidateOnFocus: true,
  })
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendFailed, setSendFailed] = useState(false)
  const [stopAttempt, setStopAttempt] = useState<number | null>(null)
  const [stopFailed, setStopFailed] = useState(false)
  const stopAttemptRef = useRef<number | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const detail = data?.thread.detail
  // 等你回复: the run ended on a question; the composer answers it (lib/agent-runs.ts addRunMessage).
  // Once answered it reads as the running thread it continues, with nothing to send or stop yet;
  // as soon as the resumed run starts, messages and stop go to that run.
  const view = data ? threadQuestionView(data.thread) : null
  const question = view?.question ?? null
  const liveRunId = view?.runId ?? runId
  const active = !!view && question !== 'resuming' && runIsActive(view.status)
  // Stop was asked for; the run keeps its live status until the daemon ends it.
  const requestedAt = stopAttempt ?? (data?.thread.stopRequestedAt ? new Date(data.thread.stopRequestedAt).getTime() : null)
  const stopRequested = active && (requestedAt !== null || !!view?.stopping)
  const stopPending = stopRequested && !stopFailed
  const items = data ? threadItems(data.chunks, data.messages, runId) : []
  useEffect(() => {
    if (!active || requestedAt === null) return
    const timer = setTimeout(() => setStopFailed(true), runStopTimeoutRemaining(requestedAt))
    return () => clearTimeout(timer)
  }, [active, requestedAt])
  useEffect(() => {
    // Acknowledgement updates the task's thread list as soon as this panel sees it.
    void mutateCache(['issue-threads', issueId])
  }, [issueId, view?.status, view?.stopping, question, mutateCache])
  async function send() {
    const text = draft.trim()
    if (!text || sending || stopRequested || question === 'resuming') return
    setSending(true); setSendFailed(false)
    try { await sendIssueThreadMessage({ issueId, runId: liveRunId, text }); setDraft(current => current.trim() === text ? '' : current); void mutate() }
    catch { setSendFailed(true) }
    finally { setSending(false) }
  }
  async function stop() {
    if (!active || (!stopFailed && (stopRequested || stopAttemptRef.current !== null))) return
    const attempt = Date.now()
    stopAttemptRef.current = attempt
    setStopAttempt(attempt); setStopFailed(false)
    void mutateCache<IssueThread[]>(['issue-threads', issueId], threads => threads?.map(thread => thread.id === runId ? { ...thread, stopping: true, continuation: thread.continuation && { ...thread.continuation, stopping: true } } : thread), { revalidate: false })
    try { await stopRun(liveRunId); void mutate(); void mutateCache(['issue-threads', issueId]) }
    catch {
      // A late response from an earlier request must not cancel a retry.
      if (stopAttemptRef.current === attempt) {
        stopAttemptRef.current = null
        setStopAttempt(null); setStopFailed(true)
        void mutateCache(['issue-threads', issueId])
      }
    }
  }
  return <section aria-label={detail?.name ?? t('title')} className="flex h-full min-h-0 flex-col">
    {!bare && <header className="flex h-12 shrink-0 items-center gap-2 border-b border-rule px-4">
      {back && <>
        <Button variant="ghost" size="sm" className="shrink-0" aria-label={t('back', { name: back })} onClick={onClose}><ChevronLeft data-icon="inline-start" />{back}</Button>
        <span aria-hidden="true" className="text-muted-foreground">/</span>
      </>}
      {detail && view && <ThreadStatusIcon status={view.status} waiting={view.waiting} />}
      <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{detail?.name ?? t('title')}</h2>
      {back && <ThreadArtifacts issueId={issueId} runId={runId} status={data?.thread.status ?? ''} />}
      {!back && <Button variant="ghost" size="icon-sm" aria-label={t('close')} onClick={onClose}><X data-icon="inline-start" /></Button>}
    </header>}
    <div className={cn('flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4', back && 'mx-auto w-full max-w-3xl')}>
      {error ? <InlineLoadError message={t('loadFailed')} retryLabel={t('retry')} onRetry={() => { void mutate() }} />
        : !data ? <div role="status" aria-label={t('loading')} className="flex flex-col gap-3"><Skeleton className="h-5 w-40" /><Skeleton className="ml-auto h-12 w-3/4" /><Skeleton className="h-12 w-2/3" /></div>
        : <>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <ThreadStatus status={view?.status ?? data.thread.status} stopping={stopRequested} waiting={question === 'waiting'} />
            <span>{t('started', { time: format.dateTime(new Date(data.thread.createdAt), { hour: '2-digit', minute: '2-digit' }) })}</span>
          </div>
          {data.thread.prompt.trim() && <p className={cn(BUBBLE, data.thread.ownedByCurrentUser ? 'self-end bg-sidebar-primary text-sidebar-primary-foreground' : 'self-start')}>{data.thread.prompt.trim()}</p>}
          <ol aria-label={t('conversation')} className="flex flex-col gap-3">
            {items.map(item => <li key={item.id} className="flex flex-col gap-1">
              {item.kind === 'agent' && <div className={cn(BUBBLE, 'self-start whitespace-normal')}><AgentMarkdown text={item.text} isStreaming={active} /></div>}
              {item.kind === 'steps' && <span className="flex items-center gap-1 text-xs text-muted-foreground"><ChevronRight className="size-3.5" aria-hidden="true" />{t('steps', { harness: harnessLabel(detail?.harness ?? ''), count: item.count })}</span>}
              {item.kind === 'error' && <FieldError className="text-xs">{item.text}</FieldError>}
              {item.kind === 'computer' && <ComputerCard botId={item.botId} runId={item.runId} task={item.task} state={active ? 'working' : (view?.status ?? data.thread.status) === 'succeeded' ? 'done' : 'failed'} />}
              {item.kind === 'person' && (item.mine
                // R-14: your own words are the blue bubble on the right.
                ? <p className={cn(BUBBLE, 'self-end bg-sidebar-primary text-sidebar-primary-foreground')}>{item.text}</p>
                // A teammate speaks from the left under their name, as in a group chat (R-13).
                : <>
                  <span className="flex items-center gap-1.5 text-xs"><PersonAvatar name={item.author} image={item.image} /><span className="font-medium">{item.author}</span><span className="text-muted-foreground">{format.dateTime(new Date(item.at), { hour: '2-digit', minute: '2-digit' })}</span></span>
                  <p className={cn(BUBBLE, 'self-start')}>{item.text}</p>
                </>)}
            </li>)}
          </ol>
          {data.thread.feedbackEligible && <ThreadFeedback runId={runId} />}
        </>}
    </div>
    {(active || question) && detail && <div className={cn('flex shrink-0 flex-col gap-1 p-3', back && 'mx-auto w-full max-w-3xl px-4 pb-4')}>
      {/* Keep the draft editable while stop waits for the daemon; do not queue new work after stop. */}
      <ChatComposer ref={inputRef} label={t('composer', { agent: detail.agentName })} value={draft} onChange={setDraft} onSubmit={() => { void send() }}
        sending={sending || stopPending} editableWhileSending submitDisabled={stopRequested || question === 'resuming'} running={active || question === 'resuming'} onStop={active && data.thread.ownedByCurrentUser && !sending && !stopPending ? () => { void stop() } : undefined} />
      {sendFailed && <FieldError className="px-3 text-xs">{t('sendFailed')}</FieldError>}
      {stopFailed && <div role="alert" className="flex items-center gap-2 px-3 text-xs"><span className="text-destructive">{t('stopFailed')}</span><Button variant="ghost" size="sm" className="min-w-22 max-sm:h-11" onClick={() => { void stop() }}>{t('retryStop')}</Button></div>}
    </div>}
  </section>
}

/**
 * 「Artifact · N」 in an open thread's header (Figma F3 `395:15024`): what this
 * thread handed over. One opens straight in the Artifact window, with this
 * thread's conversation on its right (F4); several open a list first.
 */
function ThreadArtifacts({ issueId, runId, status }: { issueId: string; runId: string; status: string }) {
  const t = useTranslations('ArtifactsPage')
  const { data, mutate } = useSWR(['run-artifacts', runId], () => listRunArtifacts(runId), { revalidateOnFocus: false })
  const [open, setOpen] = useState<string | null>(null)
  // A thread usually hands its artifact over as it finishes.
  useEffect(() => { void mutate() }, [status, mutate])
  const mine = data ?? []
  if (!mine.length) return null
  const label = t('threadEntry', { count: mine.length })
  return <>
    {mine.length === 1
      ? <Button variant="ghost" size="sm" className="shrink-0 text-muted-foreground" onClick={() => setOpen(mine[0].id)}><ArtifactIcon data-icon="inline-start" />{label}</Button>
      : <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="shrink-0 text-muted-foreground" />}><ArtifactIcon data-icon="inline-start" />{label}</DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuGroup>{mine.map(item => <DropdownMenuItem key={item.id} onClick={() => setOpen(item.id)}><ArtifactKindIcon kind={item.kind} /><span className="truncate">{item.title}</span></DropdownMenuItem>)}</DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>}
    {open && <ArtifactWindow artifact={{ id: open, runId, issueId }} onChange={setOpen} onClose={() => setOpen(null)} />}
  </>
}
