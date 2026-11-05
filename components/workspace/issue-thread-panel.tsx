'use client'

import { useViewScroll, useViewState } from '@/lib/hooks/view-state'
import { PersonAvatar } from '@/components/person-avatar'
import { useEffect, useRef, useState } from 'react'
import useSWR, { unstable_serialize, useSWRConfig } from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import { ArrowLeft, Square, SquareKanban, X } from 'lucide-react'
import { getIssueThread, getThreadChanges, sendIssueThreadReply, stopRun, type IssueThreadDetail } from '@/app/actions/agents'
import { useActionError } from '@/lib/use-action-error'
import { checkPageBuildBeforeAction } from '@/lib/app-build'
import { prepareThreadReply, type ThreadReplySubmission } from '@/lib/thread-submission-input'
import { mergeThreadChunks, runFailureText, runIsActive, runIsWorking, runStopTimeoutRemaining, threadItems } from '@/lib/issue-run-conversation'
import { ThreadSteps } from './thread-steps'
import { ThreadExecutionIdentity } from './thread-execution-identity'
import { acceptedProducerOutcome, threadQuestionView } from '@/lib/issue-threads'
import { threadComposerHarness } from '@/lib/run-model-fallback-view'
import { ChatComposer } from '@/components/coordinator/chat-composer'
import { QuoteChip, QuoteLine } from '@/components/artifacts/artifact-quote'
import { MessageActions } from '@/components/ai-elements/message'
import { CopyAction, HOVER_ACTIONS } from '@/components/chat/copy-action'
import { QUOTE_SOURCE_ATTR, SelectionQuote } from '@/components/chat/selection-quote'
import { splitReplyQuote, withReplyQuote } from '@/lib/chat-quote'
import { splitChatFiles } from '@mikka/protocol/chat-attachments'
import { ChatFileCards } from '@/components/chat/chat-file-cards'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Skeleton } from '@/components/ui/skeleton'
import { AgentMarkdown } from './agent-markdown'
import { ComputerCard } from '@/components/computer/computer-card'
import { harnessLabel, type IssueThreadsRead } from './issue-threads'
import { ThreadStatus } from './thread-status-icon'
import { RunErrorDetails, useRunErrorText } from './run-error-text'
import { ThreadModelFallbackNotice, ThreadQuotaPausedCard, ThreadQuotaSwitchLine } from './thread-quota'
import { cn } from '@/lib/utils'
import { listRunArtifacts } from '@/app/actions/artifacts'
import { ArtifactIcon } from '@/components/icons/artifact-icon'
import { ArtifactKindIcon } from '@/components/artifacts/artifact-card'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AcceptanceStateBadge, useAcceptanceTasks } from './factory-acceptance'
import { FactoryAcceptancePane } from './factory-acceptance-pane'
import { ChangesTabLabel, ThreadChangesPane } from './thread-changes'

import { openArtifact } from './workspace-navigation'
import { ThreadFeedback } from './self-improvement'
import { InlineLoadError } from '@/components/load-error'
import { FieldError } from '@/components/ui/field'
import { closeOnEscape, useFocusReturn } from '@/hooks/use-focus-return'
import { heldRevision } from '@/lib/live/revisions'
import { useLiveKey, useLiveKeys } from '@/hooks/use-live-key'

// R-32 chat: 13/21 as in Comma, also for the agent's Markdown inside a bubble.
const BUBBLE = 'max-w-[85%] rounded-2xl bg-muted px-3.5 py-2 text-sm/5.25 whitespace-pre-wrap break-words [&_[data-agent-markdown]]:leading-5.25'

/** A person's words in a thread, under the agent's words they quote (lib/chat-quote.ts), and 复制 below on hover. */
function PersonBubble({ text, mine }: { text: string; mine: boolean }) {
  const { quote, text: words } = splitReplyQuote(text)
  const attached = splitChatFiles(words)
  return <>
    <div className={cn(BUBBLE, 'flex flex-col gap-1.5', mine ? 'self-end bg-sidebar-primary text-sidebar-primary-foreground' : 'self-start')}>{quote && <QuoteLine slot="reply-quote" text={quote} />}<ChatFileCards files={attached.files} sent /><span>{attached.text}</span></div>
    <MessageActions className={cn(HOVER_ACTIONS, mine ? 'self-end' : 'self-start')}><CopyAction text={words} /></MessageActions>
  </>
}

/**
 * An open thread: a conversation between people and the agent running it (R-62, R-10).
 * It sits in the right column beside the chat or the task, wherever it was opened from
 * (R-82). Its header leads with ←, back to the list it came from (Esc does the same);
 * the state is the badge under it, so the header has no status icon. The byline names
 * the bot that dispatched it.
 */
type ThreadTab = 'chat' | 'changes' | 'acceptance'
type IssueThreadPanelProps = { /** The task it works on; null for a thread with no task. */ issueId: string | null; runId: string; /** ← and Esc: back to the list it was opened from. */ onBack?: () => void; /** ✕, only where it closes more than ← does (全部线程 under it). */ onClose?: () => void; /** Inside the Artifact window: no header, the window has its own. */ bare?: boolean; /** Open on 验收 when this thread produced a candidate waiting for acceptance. */ initialTab?: ThreadTab; /** Open another thread (an independent review or verify) from 验收. */ onOpenThread?: (runId: string) => void; /** Beside a chat: the task it works on, as a header link. */ onOpenTask?: () => void; /** The name its thread-list row shows (glossary: its task, else what it was asked); defaults to what it was asked. */ name?: string }

export function IssueThreadPanel(props: IssueThreadPanelProps) {
  // Drafts, in-flight callbacks and retry deadlines belong to exactly one run.
  return <ThreadPanel key={props.runId} {...props} />
}

function ThreadPanel({ issueId, runId, onBack, onClose, bare = false, initialTab = 'chat', onOpenThread, onOpenTask, name: listedName }: IssueThreadPanelProps) {
  const t = useTranslations('IssueThreads')
  const runErrorText = useRunErrorText()
  const format = useFormatter()
  const { mutate: mutateCache, cache } = useSWRConfig()
  const key = ['issue-thread', issueId, runId]
  // Keep incremental chunks while shared invalidations schedule the reads.
  const { data, error, mutate } = useSWR(key, async () => {
    const held = cache.get(unstable_serialize(key))?.data as IssueThreadDetail | undefined
    const previous = held?.chunkCursor ? held : undefined
    return mergeThreadChunks(previous, await getIssueThread(issueId, runId, previous?.chunkCursor))
  }, { refreshInterval: 0, revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false })
  const liveRuns = data?.live?.runs ?? [{ id: runId, workspaceId: null }]
  const liveKeys = [unstable_serialize(key)]
  // A push this thread already read is skipped; only the opened run's keys carry a revision.
  useLiveKeys(liveRuns.map(reference => ({ ...reference, kind: 'thread' as const, revisions: { [liveKeys[0]]: heldRevision(data, 'thread', reference.id) } })), liveKeys, null, { minIntervalMs: 2000 })
  useLiveKeys(liveRuns.map(reference => ({ ...reference, kind: 'run' as const, revisions: { [liveKeys[0]]: heldRevision(data, 'run', reference.id) } })), liveKeys, null)
  useLiveKey('factory_issue', issueId, liveKeys, data?.live?.issueWorkspaceId ?? null, { deadline: data?.live?.questionDeadline })
  // Frame 06: a thread whose candidate waits for acceptance has 对话 | 验收 in its header.
  const { tasks: acceptanceTasks, allTasks } = useAcceptanceTasks(issueId)
  // Keep the pane on the addressed producer; its status can follow an accepted continuation.
  const acceptance = acceptanceTasks.find(task => task.candidateRunId === runId)
  const [tab, setTab] = useViewState<ThreadTab>(`thread:${runId}:tab:${initialTab}`, initialTab)
  const accepting = !bare && Boolean(acceptance) && tab === 'acceptance'
  // 改动 (Figma 820:4843): the agent's work tree diff, read-only, once the run saved one.
  const { data: changes, mutate: mutateChanges } = useSWR(bare ? null : ['thread-changes', issueId, runId], () => getThreadChanges(issueId, runId))
  const hasChanges = !!changes && changes.state !== 'none'
  const viewingChanges = hasChanges && tab === 'changes'
  const transcript = useViewScroll<HTMLDivElement>(`thread:${runId}:chat`, !!data && !viewingChanges && !accepting)
  const [draft, setDraft] = useViewState(`thread:${runId}:draft`, '')
  const [submission, setSubmission] = useViewState<ThreadReplySubmission | null>(`thread:${runId}:submission`, null)
  // Words picked from the agent's reply with 引用: they head the next message as quote lines.
  const [replyQuote, setReplyQuote] = useViewState<string | null>(`thread:${runId}:quote`, null)
  const rootRef = useRef<HTMLElement>(null)
  const [sending, setSending] = useState(false)
  // false, or what to say: the refusal's reason when the server gave one (threadReplaced…), else 发送失败.
  const [sendFailed, setSendFailed] = useState<string | false>(false)
  useEffect(() => { if (submission && !sending) setSendFailed(t('sendFailed')) }, [submission, sending, t])
  const actionError = useActionError()
  const [stopAttempt, setStopAttempt] = useState<number | null>(null)
  const [stopFailed, setStopFailed] = useState(false)
  const stopAttemptRef = useRef<number | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  useFocusReturn(runId, headingRef, !bare)
  const detail = data?.thread.detail
  // 等你回复: the run ended on a question; the composer answers it (lib/agent-runs.ts addRunMessage).
  // Once answered it reads as the running thread it continues, with nothing to send or stop yet;
  // as soon as the resumed run starts, messages and stop go to that run.
  const view = data ? threadQuestionView(data.thread) : null
  const displayOutcome = data ? acceptedProducerOutcome(data.thread, issueId, allTasks) : null
  const question = view?.question ?? null
  const liveRunId = view?.runId ?? runId
  const active = !!view && question !== 'resuming' && runIsActive(view.status)
  // Only a run that is generating or running turns send into stop; one waiting for an answer sends (N1).
  const working = active && runIsWorking(view.status)
  // Stop was asked for; the run keeps its live status until the daemon ends it.
  const requestedAt = stopAttempt ?? (data?.thread.stopRequestedAt ? new Date(data.thread.stopRequestedAt).getTime() : null)
  const stopRequested = active && (requestedAt !== null || !!view?.stopping)
  const stopPending = stopRequested && !stopFailed
  const items = data ? threadItems(data.chunks, data.messages, runId) : []
  // A failed run says why under the stage that stopped, else at the end of the conversation.
  const failure = data && view ? runFailureText(view.status, data.thread.questionWake ? actionError('threadRecoveryUnavailable') : data.thread.error) : null
  const modelFallback = data?.thread.modelFallback?.filter(item => item.state === 'switched' || item.runId === liveRunId) ?? []
  const providerExplained = data?.thread.modelFallbackPending || modelFallback.some(item => item.runId === liveRunId)
  const failedStagesId = failure ? [...items].reverse().find(item => item.kind === 'stages' && item.stages.some(stage => !stage.ok))?.id : undefined
  // A message to an ended thread runs it again in the same thread (R-81): 重试 is that message, one tap (N2).
  const replyBlocked = data?.thread.replyAvailable === false
  const canRetry = !!failure && !!data?.thread.detail && data.thread.ownedByCurrentUser && data.thread.retryAvailable && !runIsActive(view?.status ?? '')
  const failureText = runErrorText(failure)
  const failureLine = failure && !providerExplained && <div className="flex items-start gap-2" data-slot="thread-failure">
    <div className="flex min-w-0 flex-1 flex-col">
      <p className="line-clamp-2 text-xs break-words text-destructive-foreground" title={failureText.message ?? undefined}>{failureText.message}</p>
      {failureText.code && <RunErrorDetails code={failureText.code} />}
    </div>
    {canRetry && <Button variant="outline" size="xs" className="shrink-0 pointer-coarse:h-11" disabled={sending} onClick={() => { void send(t('retry'), true) }}>{t('retry')}</Button>}
  </div>
  useEffect(() => {
    if (!active || requestedAt === null) return
    const timer = setTimeout(() => setStopFailed(true), runStopTimeoutRemaining(requestedAt))
    return () => clearTimeout(timer)
  }, [active, requestedAt])
  // The run saves its work as it goes; read it again when its state moves.
  useEffect(() => { void mutateChanges() }, [view?.status, mutateChanges])
  useEffect(() => {
    // Acknowledgement updates the task's thread list as soon as this panel sees it.
    void mutateCache(['issue-threads', issueId])
  }, [issueId, view?.status, view?.stopping, question, mutateCache])
  async function send(retry?: string, retryOriginalSession?: true) {
    const text = retry ?? draft.trim()
    const questionWake = retryOriginalSession ? data?.thread.questionWake : null
    if (!text || sending || stopRequested || (question === 'resuming' && !questionWake)) return
    if (retryOriginalSession ? !canRetry : replyBlocked) return
    setSending(true); setSendFailed(false)
    try {
      if (!await checkPageBuildBeforeAction()) return
      const words = retry === undefined ? withReplyQuote(text, replyQuote) : text
      const request = retryOriginalSession ? { runId: liveRunId, text: words, retryOriginalSession,
        ...(questionWake ? { questionWakeGeneration: questionWake.generation } : {}) } : prepareThreadReply(submission, liveRunId, words)
      if ('requestId' in request) setSubmission(request)
      const result = await sendIssueThreadReply({ issueId, ...request })
      if (result.error) { setSendFailed(actionError(result.error)); if ('requestId' in request) setSubmission(null); return }
      if ('requestId' in request) setSubmission(null)
      if (retry === undefined) { setDraft(current => current.trim() === text ? '' : current); setReplyQuote(null) }
      void mutate(); void mutateCache(['issue-threads', issueId])
    }
    catch { setSendFailed(t('sendFailed')) }
    finally { setSending(false) }
  }
  async function stop() {
    if (!active || (!stopFailed && (stopRequested || stopAttemptRef.current !== null))) return
    const attempt = Date.now()
    stopAttemptRef.current = attempt
    setStopAttempt(attempt); setStopFailed(false)
    void mutateCache<IssueThreadsRead>(['issue-threads', issueId], read => read && { ...read, threads: read.threads.map(thread => thread.id === runId ? { ...thread, stopping: true, continuation: thread.continuation && { ...thread.continuation, stopping: true } } : thread) }, { revalidate: false })
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
  const canStop = active && !!data?.thread.ownedByCurrentUser && !sending && !stopPending
  const title = listedName || (detail?.name ?? t('title'))
  // Esc inside the thread is ←; in its composer or another field it only leaves the field (decision 0301). A window opened from it keeps its own Esc.
  return <section ref={rootRef} aria-label={title} className="flex h-full min-h-0 flex-col" onKeyDown={bare || !onBack ? undefined : event => closeOnEscape(event, headingRef.current, onBack)}>
    {!bare && <header className={cn('flex h-12 shrink-0 items-center gap-2 border-b border-rule px-4', onBack && 'pl-2', acceptance && 'max-sm:h-auto max-sm:flex-wrap max-sm:py-2')}>
      {onBack && <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="shrink-0" aria-label={t('back')} aria-keyshortcuts="Escape" onClick={onBack} />}><ArrowLeft data-icon="inline-start" /></TooltipTrigger><TooltipContent side="bottom">{t('back')}</TooltipContent></Tooltip>}
      <h2 ref={headingRef} tabIndex={-1} className={cn('min-w-0 truncate text-sm font-semibold outline-none', !acceptance && 'flex-1')}>{title}</h2>
      {acceptance && <><AcceptanceStateBadge task={acceptance} /><span className="flex-1" /></>}
      <ThreadArtifacts runId={runId} status={data?.thread.status ?? ''} />
      {data?.thread.ownedByCurrentUser && <ThreadExecutionIdentity runId={liveRunId} />}
      {/* Stop lives here for every live run, also one waiting for an answer, whose composer button sends. */}
      {canStop && <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground" aria-label={t('stop')} data-slot="thread-stop" onClick={() => { void stop() }} />}><Square data-icon="inline-start" className="fill-current" /></TooltipTrigger><TooltipContent side="bottom">{t('stop')}</TooltipContent></Tooltip>}
      {onOpenTask && <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground" aria-label={t('openTask')} onClick={onOpenTask} />}><SquareKanban data-icon="inline-start" /></TooltipTrigger><TooltipContent side="bottom">{t('openTask')}</TooltipContent></Tooltip>}
      {/* Frame 06 draws the machine in the wide centre-column header; the side panel has no room for it. */}
      {acceptance && !hasChanges && <Tabs value={tab} onValueChange={value => setTab(value as ThreadTab)} className="shrink-0 max-sm:order-last max-sm:w-full">
        <TabsList className="max-sm:w-full"><TabsTrigger value="chat">{t('chatTab')}</TabsTrigger><TabsTrigger value="acceptance">{t('acceptanceTab')}</TabsTrigger></TabsList>
      </Tabs>}
      {onClose && <Button variant="ghost" size="icon-sm" aria-label={t('close')} onClick={onClose}><X data-icon="inline-start" /></Button>}
    </header>}
    {/* With 改动 the tabs get their own row: the side panel has no room for them beside the title. */}
    {!bare && hasChanges && <div className="flex shrink-0 items-center px-3 pt-2">
      <Tabs value={tab} onValueChange={value => setTab(value as ThreadTab)}>
        <TabsList><TabsTrigger value="chat">{t('chatTab')}</TabsTrigger><TabsTrigger value="changes" className="gap-1.5"><ChangesTabLabel changes={changes.state === 'ready' ? changes.changes : null} /></TabsTrigger>{acceptance && <TabsTrigger value="acceptance">{t('acceptanceTab')}</TabsTrigger>}</TabsList>
      </Tabs>
    </div>}
    {viewingChanges ? (changes.state === 'ready'
      ? <ThreadChangesPane stateKey={`thread:${runId}:changes`} changes={changes.changes} />
      : <p className="p-4 text-sm text-muted-foreground">{t('changesTooLarge')}</p>)
    : accepting && acceptance ? <div className="flex min-h-0 flex-1 flex-col"><FactoryAcceptancePane task={acceptance} onOpenThread={onOpenThread} /></div> : <>
    <div ref={transcript} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
      {error ? <InlineLoadError message={t('loadFailed')} retryLabel={t('retry')} onRetry={() => { void mutate() }} />
        : !data ? <div role="status" aria-label={t('loading')} className="flex flex-col gap-3"><Skeleton className="h-5 w-40" /><Skeleton className="ml-auto h-12 w-3/4" /><Skeleton className="h-12 w-2/3" /></div>
        : <>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <ThreadStatus status={view?.status ?? data.thread.status} outcome={displayOutcome} stopping={stopRequested} waiting={question === 'waiting'} />
            <span>{t('started', { time: format.dateTime(new Date(data.thread.createdAt), { hour: '2-digit', minute: '2-digit' }) })}</span>
            {/* The bot that dispatched it, also when it is not the chat beside it (R-78, R-82). */}
            {detail?.agentName && <span>{detail.agentName} {t('dispatched')}</span>}
          </div>
          {data.thread.prompt.trim() && <div className="group/message flex flex-col gap-1"><PersonBubble text={data.thread.prompt.trim()} mine={data.thread.ownedByCurrentUser} /></div>}
          <ol aria-label={t('conversation')} className="flex flex-col gap-3">
            {items.map(item => <li key={item.id} className="group/message flex flex-col gap-1">
              {item.kind === 'agent' && <>
                <div {...{ [QUOTE_SOURCE_ATTR]: '' }} className={cn(BUBBLE, 'self-start whitespace-normal')}><AgentMarkdown text={item.text} isStreaming={active} /></div>
                <MessageActions className={cn('self-start', HOVER_ACTIONS)}><CopyAction text={item.text} /></MessageActions>
              </>}
              {item.kind === 'steps' && <ThreadSteps stateKey={`thread:${runId}:steps:${item.id}`} harness={detail?.harness ?? ''} steps={item.steps} />}
              {item.kind === 'error' && <FieldError className="text-xs">{item.text}</FieldError>}
              {item.kind === 'stages' && <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground" data-slot="thread-stages">
                {item.stages.map((stage, index) => <span key={index} className={cn(!stage.ok && 'text-destructive-foreground')}>
                  {t(`stages.${stage.stage}`)} {t('stages.duration', { seconds: (stage.ms / 1000).toFixed(1) })} {stage.ok ? '✓' : '✗'}
                </span>)}
              </p>}
              {item.id === failedStagesId && failureLine}
              {item.kind === 'computer' && <ComputerCard botId={item.botId} runId={item.runId} task={item.task} state={active ? 'working' : (view?.status ?? data.thread.status) === 'succeeded' ? 'done' : 'failed'} />}
              {item.kind === 'person' && (item.mine
                // R-14: your own words are the blue bubble on the right.
                ? <PersonBubble text={item.text} mine />
                // A teammate speaks from the left under their name, as in a group chat (R-13).
                : <>
                  <span className="flex items-center gap-1.5 text-xs"><PersonAvatar name={item.author} image={item.image} /><span className="font-medium">{item.author}</span><span className="text-muted-foreground">{format.dateTime(new Date(item.at), { hour: '2-digit', minute: '2-digit' })}</span></span>
                  <PersonBubble text={item.text} mine={false} />
                </>)}
            </li>)}
          </ol>
          {!failedStagesId && failureLine}
          {/* The subscription ran out and the run went on on the person's key (lib/run-quota.ts). */}
          {data.thread.quota?.switched.map(item => <ThreadQuotaSwitchLine key={item.runId} switched={item} />)}
          {modelFallback.map(item => <ThreadModelFallbackNotice key={item.runId} item={item}
            retry={item.state !== 'switched' && canRetry ? () => { void send(t('retry'), true) } : undefined} retrying={sending} />)}
          {data.thread.feedbackEligible && <ThreadFeedback runId={runId} />}
        </>}
    </div>
    {data?.thread.quota?.paused && <div className="shrink-0 p-3">
      <ThreadQuotaPausedCard paused={data.thread.quota.paused} onContinued={() => { void mutate(); void mutateCache(['issue-threads', issueId]) }} />
    </div>}
    {/* R-10: an open thread always ends in the composer, finished or not. A message to an ended thread runs it
        again in the same thread (R-81); only a thread the viewer cannot see in full (no `detail`) has none. */}
    {detail && <div data-slot="thread-composer" className="flex shrink-0 flex-col gap-1 p-3">
      {/* Keep the draft editable while stop waits for the daemon; do not queue new work after stop. */}
      <ChatComposer ref={inputRef} label={replyBlocked ? t('checkEnded') : t('composer', { agent: harnessLabel(threadComposerHarness(detail.harness, liveRunId, modelFallback)) })} value={draft} onChange={setDraft} onSubmit={() => { void send() }} attachmentScope={{ kind: 'thread', id: liveRunId }}
        quote={replyQuote ? <QuoteChip slot="reply-quote-chip" text={replyQuote} onRemove={() => { setReplyQuote(null); inputRef.current?.focus() }} /> : undefined}
        sending={sending || stopPending} editableWhileSending submitDisabled={replyBlocked || stopRequested || question === 'resuming'} running={working || (question === 'resuming' && !data?.thread.questionWake)} thread onStop={working && canStop ? () => { void stop() } : undefined} />
      {sendFailed && <FieldError className="px-3 text-xs">{sendFailed}</FieldError>}
      {stopFailed && <div role="alert" className="flex items-center gap-2 px-3 text-xs"><span className="text-destructive-foreground">{t('stopFailed')}</span><Button variant="ghost" size="sm" className="min-w-22 max-sm:h-11" onClick={() => { void stop() }}>{t('retryStop')}</Button></div>}
    </div>}
    </>}
    {detail && <SelectionQuote root={rootRef} onQuote={text => { setReplyQuote(text); inputRef.current?.focus() }} />}
  </section>
}

/**
 * 「Artifact · N」 in an open thread's header (Figma F3 `395:15024`): what this
 * thread handed over. One opens straight in the Artifact window, with this
 * thread's conversation on its right (F4); several open a list first.
 */
function ThreadArtifacts({ runId, status }: { runId: string; status: string }) {
  const t = useTranslations('ArtifactsPage')
  const { data, mutate } = useSWR(['run-artifacts', runId], () => listRunArtifacts(runId))
  // A thread usually hands its artifact over as it finishes.
  useEffect(() => { void mutate() }, [status, mutate])
  const mine = data ?? []
  if (!mine.length) return null
  const label = t('threadEntry', { count: mine.length })
  return <>
    {mine.length === 1
      ? <Button variant="ghost" size="sm" className="shrink-0 text-muted-foreground" onClick={() => openArtifact(mine[0].id)}><ArtifactIcon data-icon="inline-start" />{label}</Button>
      : <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="shrink-0 text-muted-foreground" />}><ArtifactIcon data-icon="inline-start" />{label}</DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuGroup>{mine.map(item => <DropdownMenuItem key={item.id} onClick={() => openArtifact(item.id)}><ArtifactKindIcon kind={item.kind} /><span className="truncate">{item.title}</span></DropdownMenuItem>)}</DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>}
  </>
}
