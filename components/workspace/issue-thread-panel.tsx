'use client'

import { useViewScroll, useViewState } from '@/lib/hooks/view-state'
import { PersonAvatar } from '@/components/person-avatar'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import useSWR, { unstable_serialize, useSWRConfig } from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { MessageSquareDiff } from 'lucide-react'
import { getIssueThread, getThreadInstructions, stopRun, getThreadContinuationModels, type IssueThreadDetail } from '@/app/actions/agents'
import { useThreadChanges } from '@/hooks/use-thread-run-reads'
import { useActionError } from '@/lib/use-action-error'
import { sendReviewChange, type ReviewChangeTarget } from '@/lib/factory/review-change'
import { RequestError } from '@/lib/factory/browser-request'
import { useChatDelivery, useThreadReplyCommand, type ChatSubmission } from '@/lib/hooks/chat-delivery'
import { prepareThreadReply, type ThreadReplySubmission } from '@/lib/thread-submission-input'
import { mergeThreadChunks, runFailureText, runIsActive, runIsWorking, runStopTimeoutRemaining, threadItems } from '@/lib/issue-run-conversation'
import { ThreadSteps } from './thread-steps'
import { ThreadExecutionIdentity } from './thread-execution-identity'
import { ThreadRunPlace } from './thread-run-place'
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
import { CollapsibleMessage } from '@/components/chat/collapsible-message'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { AgentMarkdown } from './agent-markdown'
import { ComputerCard } from '@/components/computer/computer-card'
import { harnessLabel, type IssueThreadsRead } from './issue-threads'
import { BotModelPicker } from '@/components/coordinator/bot-model-picker'
import { choiceFromMenu, threadModelKey, type ThreadModelChoice } from '@/lib/thread-model-choice'
import { ThreadScreen } from '@ui-slot/thread'
import type { ThreadEntry, ThreadEntryPart } from '@/components/slots/thread-contract'
import { HarnessMark, harnessName, ModelLabel } from '@/components/labels/entity-labels'
import { navigate } from './workspace-navigation'
import { ThreadHeader, ThreadStatusLine } from './thread-header'
import { PersonReferences, ThreadReferencePicker } from './thread-references'
import { ThreadContextUsage } from './thread-context-usage'
import { ThreadOutlineIndex } from './thread-outline-index'
import { threadOutline } from '@/lib/thread-outline'
import { useRightColumnWiden } from './right-column-widen'
import { RunErrorDetails, useRunErrorText } from './run-error-text'
import { ThreadModelFallbackNotice, ThreadQuotaPausedCard, ThreadQuotaSwitchLine } from './thread-quota'
import { cn } from '@/lib/utils'
import { ThreadArtifactButton, ThreadArtifactCards } from './artifact-review'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AcceptanceStateBadge, useAcceptanceTasks } from './factory-acceptance'
import { FactoryAcceptancePane } from './factory-acceptance-pane'
import { ChangesTabLabel, ThreadChangesPane } from './thread-changes'

import { ThreadFeedback } from './self-improvement'
import { InlineLoadError } from '@/components/load-error'
import { FieldError } from '@/components/ui/field'
import { closeOnEscape, useFocusReturn } from '@/hooks/use-focus-return'
import { heldRevision } from '@/lib/live/revisions'
import { useLiveKey, useLiveKeys } from '@/hooks/use-live-key'
import { readAccessFailure } from '@/lib/swr/persistent-cache'

// R-32 chat: 13/21 as in Comma, also for the agent's Markdown inside a bubble.
const BUBBLE = 'max-w-[85%] rounded-2xl bg-muted px-3.5 py-2 text-sm/5.25 whitespace-pre-wrap break-words [&_[data-agent-markdown]]:leading-5.25'

/**
 * A person's words in a thread, under the agent's words they quote (lib/chat-quote.ts), and 复制 below on hover. Theirs sit
 * on the page surface with a hairline, as the main chat's person bubble does; the accent is kept for actions (UI audit task-07).
 */
function PersonBubble({ text, mine }: { text: string; mine: boolean }) {
  const { quote, text: words } = splitReplyQuote(text)
  const attached = splitChatFiles(words)
  return <>
    <div className={cn(BUBBLE, 'flex flex-col', mine ? 'self-end bg-background text-foreground ring-1 ring-border' : 'self-start')}><CollapsibleMessage>{quote && <QuoteLine slot="reply-quote" text={quote} />}<ChatFileCards files={attached.files} sent /><span><PersonReferences text={attached.text} /></span></CollapsibleMessage></div>
    <MessageActions className={cn(HOVER_ACTIONS, mine ? 'self-end' : 'self-start')}><CopyAction text={words} /></MessageActions>
  </>
}

/**
 * 查看完整指令: what the Agent was sent around the task (Factory guidance, repository
 * checks, standing instructions), read only when asked, as Codex cloud and Devin keep
 * the system prompt out of the conversation.
 */
function ThreadInstructions({ issueId, runId, mine }: { issueId: string | null; runId: string; mine: boolean }) {
  const t = useTranslations('IssueThreads')
  const [open, setOpen] = useState(false)
  const [text, setText] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const toggle = async () => {
    if (open) { setOpen(false); return }
    setOpen(true)
    if (text !== null) return
    setFailed(false)
    try { setText(await getThreadInstructions(issueId, runId)) } catch { setFailed(true) }
  }
  return <div className={cn('flex max-w-[85%] flex-col gap-1', mine ? 'self-end items-end' : 'self-start')}>
    <Button type="button" variant="link" size="xs" aria-expanded={open} className="h-auto px-0 text-muted-foreground" onClick={() => { void toggle() }}>{open ? t('hideInstructions') : t('fullInstructions')}</Button>
    {open && (failed ? <InlineLoadError message={t('loadFailed')} retryLabel={t('retry')} onRetry={() => { setOpen(false); void toggle() }} />
      : text === null ? <Skeleton className="h-12 w-64" />
      : <div data-slot="thread-instructions" className="w-full rounded-xl border border-border px-3 py-2 text-xs/5 whitespace-pre-wrap break-words text-muted-foreground"><CollapsibleMessage>{text}</CollapsibleMessage></div>)}
  </div>
}

/**
 * An open thread: a conversation between people and the agent running it (R-62, R-10).
 * It sits in the right column beside the chat or the task, wherever it was opened from
 * (R-82). Its header leads with ←, back to the list it came from (Esc does the same);
 * the state is the badge under it, so the header has no status icon. The byline names
 * the bot that dispatched it.
 */
type ThreadTab = 'chat' | 'changes' | 'acceptance'
type IssueThreadPanelProps = { /** The task it works on; null for a thread with no task. */ issueId: string | null; runId: string; /** ← and Esc: back to the list it was opened from. */ onBack?: () => void; /** ✕, only where it closes more than ← does (全部线程 under it). */ onClose?: () => void; /** Inside the Artifact window: no header, the window has its own. */ bare?: boolean; /** Open on 验收 when this thread produced a candidate waiting for acceptance. */ initialTab?: ThreadTab; /** Open another thread (an independent review or verify) from 验收. */ onOpenThread?: (runId: string) => void; /** Beside a chat: the task it works on, as a header link. */ onOpenTask?: () => void; /** The name its thread-list row shows (glossary: its task, else what it was asked); defaults to what it was asked. */ name?: string; /** Inside the Artifact window (P2): 要求修改 waits in the composer as a chip; sending it starts the fix run on the same PR. */ changeRequest?: ThreadChangeRequest; /** A task's earlier attempts, drawn above this one's transcript in the same scroll (the task-conversation slot). */ before?: ReactNode; /** With `before`: scroll to this run's section, an earlier one or this panel's own, once the conversation has loaded. */ focusRunId?: string; /** Only the transcript, for an earlier attempt inside another panel's `before`: no header, scroll, composer or acceptance. */ transcriptOnly?: boolean; /** Its place in its task's one conversation: the status line names the attempt, and the dispatch is not a person's bubble. */ attempt?: { n: number; first: boolean; taskTitle?: string }; /** With a layer's thread screen: this run's rows as data, reported instead of drawn (an earlier attempt in a task's conversation). */ collect?: (runId: string, entries: ThreadEntry[]) => void; /** With a layer's thread screen: the earlier attempts' rows, above this run's own. */ beforeEntries?: ThreadEntry[]; /** Readable control-run evidence that follows the writable root, without acquiring its composer. */ afterEntries?: ThreadEntry[]; after?: ReactNode }

export type ThreadChangeRequest = ReviewChangeTarget & { onCancel: () => void }

export function IssueThreadPanel(props: IssueThreadPanelProps) {
  // Drafts, in-flight callbacks and retry deadlines belong to exactly one run.
  return <ThreadPanel key={props.runId} {...props} />
}

function ThreadPanel({ issueId, runId, onBack, onClose, bare = false, initialTab = 'chat', onOpenThread, onOpenTask, name: listedName, changeRequest, before, focusRunId, transcriptOnly = false, attempt, collect, beforeEntries, afterEntries, after }: IssueThreadPanelProps) {
  const t = useTranslations('IssueThreads')
  const runErrorText = useRunErrorText()
  const format = useFormatter()
  const { mutate: mutateCache, cache } = useSWRConfig()
  const key = ['issue-thread', issueId, runId]
  // Keep incremental chunks while shared invalidations schedule the reads.
  const { data: read, error, mutate } = useSWR(key, async () => {
    const held = cache.get(unstable_serialize(key))?.data as IssueThreadDetail | undefined
    const previous = held?.chunkCursor ? held : undefined
    return mergeThreadChunks(previous, await getIssueThread(issueId, runId, previous?.chunkCursor))
  }, { refreshInterval: 0, revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false })
  const [accessRejected, setAccessRejected] = useState(false)
  // Browser RPC carries runNotFound as HTTP 400; it is still a definitive read refusal.
  const refused = !!readAccessFailure(error) || error?.code === 'runNotFound' || error?.code === 'desktop_session_changed'
  useEffect(() => {
    if (refused) setAccessRejected(true)
    else if (!error) setAccessRejected(false)
  }, [refused, error])
  // Observe SWR's successful read, including one started before this panel remounted.
  const readRejected = refused || Boolean(error && accessRejected)
  const data = readRejected ? undefined : read
  const backgroundFailed = Boolean(error && data)
  const readFailedMessage = t('loadFailed'), retryLabel = t('retry')
  useEffect(() => {
    const notice = `issue-thread-read-${runId}`
    if (backgroundFailed) toast.error(readFailedMessage, { id: notice, duration: Infinity, action: { label: retryLabel, onClick: event => { event.preventDefault(); void mutate() } } })
    else toast.dismiss(notice)
    return () => { toast.dismiss(notice) }
  }, [backgroundFailed, runId, mutate, readFailedMessage, retryLabel])
  const liveRuns = data?.live?.runs ?? [{ id: runId, workspaceId: null }]
  const liveKeys = [unstable_serialize(key)]
  // A push this thread already read is skipped; only the opened run's keys carry a revision.
  useLiveKeys(liveRuns.map(reference => ({ ...reference, kind: 'thread' as const, revisions: { [liveKeys[0]]: heldRevision(data, 'thread', reference.id) } })), liveKeys, null, { minIntervalMs: 2000 })
  useLiveKeys(liveRuns.map(reference => ({ ...reference, kind: 'run' as const, revisions: { [liveKeys[0]]: heldRevision(data, 'run', reference.id) } })), liveKeys, null)
  useLiveKey('factory_issue', issueId, liveKeys, data?.live?.issueWorkspaceId ?? null, { deadline: data?.live?.questionDeadline })
  // Frame 06: a thread whose candidate waits for acceptance has 对话 | 验收 in its header.
  const { tasks: acceptanceTasks, allTasks } = useAcceptanceTasks(issueId)
  // Keep the pane on the addressed producer; its status can follow an accepted continuation.
  const acceptance = readRejected ? undefined : acceptanceTasks.find(task => task.candidateRunId === runId)
  const [tab, setTab] = useViewState<ThreadTab>(`thread:${runId}:tab:${initialTab}`, initialTab)
  const accepting = !bare && Boolean(acceptance) && tab === 'acceptance'
  // 改动 (Figma 820:4843): the agent's work tree diff, read-only, once the run saved one.
  const view = data ? threadQuestionView(data.thread) : null
  const { data: changes } = useThreadChanges(issueId, bare ? null : runId, view?.status)
  const hasChanges = !readRejected && !!changes && changes.state !== 'none'
  const viewingChanges = hasChanges && tab === 'changes'
  const transcript = useViewScroll<HTMLDivElement>(`thread:${runId}:chat`, !!data && !viewingChanges && !accepting)
  const [draft, setDraft] = useViewState(`thread:${runId}:draft`, '')
  const feedback = useTranslations('Coordinator')
  const deliveryLabels = useTranslations('HostedThread')
  const writer = useThreadReplyCommand()
  const delivery = useChatDelivery<ChatSubmission & { review?: ReviewChangeTarget; runId: string; expectedOwnerId?: string; expectedWorkspaceId?: string; modelChoice?: ThreadModelChoice }>(`thread:${runId}`, feedback('sendUncertain'))
  const sendLock = useRef(false)
  const [pickedModel, setPickedModel] = useViewState<ThreadModelChoice | null>(`thread:${runId}:next-model`, null)
  const [submission, setSubmission] = useViewState<ThreadReplySubmission | null>(`thread:${runId}:submission`, null)
  // Words picked from the agent's reply with 引用: they head the next message as quote lines.
  const [replyQuote, setReplyQuote] = useViewState<string | null>(`thread:${runId}:quote`, null)
  const rootRef = useRef<HTMLElement>(null)
  const [sending, setSending] = useState(false)
  // false, or what to say: the refusal's reason when the server gave one (threadReplaced…), else 发送失败.
  const [sendFailed, setSendFailed] = useState<string | false>(false)

  const actionError = useActionError()
  const [stopAttempt, setStopAttempt] = useState<number | null>(null)
  const [stopFailed, setStopFailed] = useState(false)
  const stopAttemptRef = useRef<number | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  useFocusReturn(runId, headingRef, !bare)
  // ⤢ of the right column it sits in, for a layer's header; null in task detail and the Artifact window.
  const widen = useRightColumnWiden()
  const detail = data?.thread.detail
  // 等你回复: the run ended on a question; the composer answers it (lib/agent-runs.ts addRunMessage).
  // Once answered it reads as the running thread it continues, with nothing to send or stop yet;
  // as soon as the resumed run starts, messages and stop go to that run.
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
  const confirmedIds = useMemo(() => new Set(data?.messages?.flatMap(message => message.submissionId ? [message.submissionId] : [])), [data?.messages])
  const localMessages = delivery.rows.filter(row => !confirmedIds.has(row.id))
  useEffect(() => {
    if (delivery.rows.some(row => confirmedIds.has(row.id))) delivery.setRows(current => current.filter(row => !confirmedIds.has(row.id)))
  }, [confirmedIds, delivery.rows, delivery.setRows])
  const items = data ? threadItems(data.chunks, data.messages, runId) : []
  // The jump index, from the items already built: never a second fold of the stream.
  const outline = threadOutline(items)
  // A failed run says why under the stage that stopped, else at the end of the conversation.
  const failure = data && view ? runFailureText(view.status, data.thread.questionWake ? actionError('threadRecoveryUnavailable') : data.thread.error) : null
  const modelFallback = data?.thread.modelFallback?.filter(item => item.state === 'switched' || item.runId === liveRunId) ?? []
  const providerExplained = data?.thread.modelFallbackPending || modelFallback.some(item => item.runId === liveRunId)
  const failedStagesId = failure ? [...items].reverse().find(item => item.kind === 'stages' && item.stages.some(stage => !stage.ok))?.id : undefined
  // A message to an ended thread runs it again in the same thread (R-81): 重试 is that message, one tap (N2).
  const replyBlocked = transcriptOnly || data?.thread.replyAvailable === false
  const canRetry = !transcriptOnly && !!failure && !!data?.thread.detail && data.thread.ownedByCurrentUser && data.thread.retryAvailable && !runIsActive(view?.status ?? '')
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
  useEffect(() => {
    // Acknowledgement updates the task's thread list as soon as this panel sees it.
    void mutateCache(['issue-threads', issueId])
  }, [issueId, view?.status, view?.stopping, question, mutateCache])
  // 要求修改 from the Artifact window puts the person straight into the composer.
  const requesting = Boolean(changeRequest)
  useEffect(() => { if (requesting) inputRef.current?.focus() }, [requesting])
  async function send(retry?: string, retryOriginalSession?: true, previous?: typeof delivery.rows[number]) {
    if (transcriptOnly || sendLock.current || readRejected) return
    const review = previous?.review ?? (!previous && !retry ? changeRequest : undefined)
    const text = previous?.text ?? retry ?? draft.trim()
    const questionWake = retryOriginalSession ? data?.thread.questionWake : null
    if (!text || sending || stopRequested || (question === 'resuming' && !questionWake)) return
    if (retryOriginalSession ? !canRetry : !review && replyBlocked) return
    const words = previous?.text ?? (retry === undefined && !review ? withReplyQuote(text, replyQuote) : text)
    // Preserve an interrupted send from the previous client version when its unchanged draft is submitted.
    const saved = prepareThreadReply(submission, liveRunId, words, undefined, !review && !retryOriginalSession && !active && !question && !replyBlocked && pickedModel ? pickedModel : undefined)
    const command = previous ?? { id: saved.requestId, runId: saved.runId, text: words, at: Date.now(), ...(saved.modelChoice ? { modelChoice: saved.modelChoice } : {}), ...(review ? { review: { label: review.label, binding: review.binding } } : {}),
      expectedOwnerId: data?.live?.viewerId, expectedWorkspaceId: data?.live?.runs.find(run => run.id === liveRunId)?.workspaceId ?? undefined }
    if (!retryOriginalSession && !delivery.begin(command)) return
    sendLock.current = true
    setSending(true); setSendFailed(false)
    if (!retryOriginalSession && !previous) { setDraft(''); setReplyQuote(null); setSubmission(null); if (saved.modelChoice) setPickedModel(null); if (review) changeRequest?.onCancel() }
    const fail = (reason: string) => retryOriginalSession ? setSendFailed(reason) : delivery.finish(command.id, { error: reason })
    try {
      if (command.review) {
        const blocked = await writer.preflight()
        if (blocked) { fail(blocked); return }
        await sendReviewChange(command.review.binding, command.id, command.text, command.expectedOwnerId)
        delivery.finish(command.id, {})
        void mutate().catch(() => undefined)
        void mutateCache(`/api/factory/tasks/${command.review.binding.taskId}/approval?view=ledger`)
        return
      }
      const result = await writer.submit(issueId, retryOriginalSession ? { runId: liveRunId, text: words, retryOriginalSession,
        ...(questionWake ? { questionWakeGeneration: questionWake.generation } : {}) } : command)
      if (result.status !== 'accepted') { fail(result.error); return }
      if (!retryOriginalSession) delivery.finish(command.id, {})
      void mutate().catch(() => undefined); void mutateCache(['issue-threads', issueId])
    } catch (error) {
      const reason = error instanceof RequestError && error.status < 500 ? error.status === 429 ? feedback('sendRateLimited') : actionError(error.code) : feedback('sendUncertain')
      fail(reason)
    }
    finally { sendLock.current = false; setSending(false) }
  }
  async function stop() {
    if (transcriptOnly) return
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
  const title = (!readRejected && listedName) || (detail?.name ?? t('title'))
  // A run opened from its task's 活动 scrolls to its section in the joined conversation (TaskConversation), the newest
  // run's own section included. It waits until no section above still shows its skeleton: a transcript that loads
  // after the scroll would push the opened run back out of view.
  const joined = Boolean(before || after)
  useEffect(() => {
    const root = rootRef.current
    if (!focusRunId || !joined || !root) return
    const reveal = () => {
      const section = root.querySelector(`[data-attempt-section="${CSS.escape(focusRunId)}"]`)
      if (!section?.childElementCount || root.querySelector('[data-thread-loading]')) return false
      section.scrollIntoView({ block: 'start' })
      return true
    }
    if (reveal()) return
    const observer = new MutationObserver(() => { if (reveal()) observer.disconnect() })
    observer.observe(root, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [focusRunId, runId, joined])
  const transcriptBody = <>
      {error && !data ? <InlineLoadError message={readFailedMessage} retryLabel={retryLabel} onRetry={() => { void mutate() }} />
        : !data ? <div role="status" aria-label={t('loading')} data-thread-loading className="flex flex-col gap-3"><Skeleton className="h-5 w-40" /><Skeleton className="ml-auto h-12 w-3/4" /><Skeleton className="h-12 w-2/3" /></div>
        : <>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <ThreadStatusLine pauseReason={view?.pauseReason} status={view?.status ?? data.thread.status} outcome={displayOutcome} stopping={stopRequested} waiting={question === 'waiting'} startedAt={new Date(data.thread.createdAt).toISOString()} dispatchedBy={detail?.agentName || null}
              issueId={issueId} runId={runId} harness={detail?.harness ?? null}
              {...(attempt ? { attempt: { ...attempt, harness: detail?.harness ?? null, prompt: data.thread.prompt.trim() || null } } : {})} />
            {/* What the run holds (lib/context-usage.ts). Its own row keeps the shared status-line slot unchanged. */}
            {data.context && <ThreadContextUsage usage={data.context} />}
            {/* A long thread's jump index (lib/thread-outline.ts). It scrolls to the
                rows the list already anchors with `data-thread-item`. */}
            <ThreadOutlineIndex entries={outline} />
          </div>
          {/* In a task's one conversation the dispatch is the status line's, not a person's bubble (#1681). */}
          {!attempt && (data.thread.prompt.trim() || data.thread.hasInstructions) && <div className="group/message flex flex-col gap-1">{data.thread.prompt.trim() && <PersonBubble text={data.thread.prompt.trim()} mine={data.thread.ownedByCurrentUser} />}{data.thread.hasInstructions && <ThreadInstructions issueId={issueId} runId={runId} mine={data.thread.ownedByCurrentUser} />}</div>}
          <ol aria-label={t('conversation')} className="flex flex-col gap-3">
            {/* `data-thread-item` is the jump index's anchor (lib/thread-outline.ts). It is
                the item id, never its position: an index would point at the wrong row once
                the list changes, and a jump to the wrong message is worse than none. */}
            {items.map(item => <li key={item.id} data-thread-item={item.id} className="group/message flex flex-col gap-1">
              {item.kind === 'agent' && <>
                <div {...{ [QUOTE_SOURCE_ATTR]: '' }} className={cn(BUBBLE, 'self-start whitespace-normal')}><AgentMarkdown text={item.text} isStreaming={active} /></div>
                <MessageActions className={cn('self-start', HOVER_ACTIONS)}><CopyAction text={item.text} /></MessageActions>
              </>}
              {item.kind === 'steps' && <ThreadSteps stateKey={`thread:${runId}:steps:${item.id}`} steps={item.steps} />}
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
            {!readRejected && localMessages.map(row => <li key={row.id} data-delivery-id={row.id} data-delivery-phase={row.phase} className="flex flex-col items-end gap-1">
              <PersonBubble text={row.text} mine />
              {row.phase === 'sending' && <span role="status" className="text-xs text-muted-foreground">{deliveryLabels('sending')}</span>}
              {row.phase === 'failed' && <span role="alert" className="flex items-center gap-2 text-xs">
                {row.error}{(!replyBlocked || row.review) && <Button size="xs" variant="ghost" onClick={() => { void send(undefined, undefined, row) }}>{retryLabel}</Button>}
              </span>}
            </li>)}
          </ol>
          {!failedStagesId && failureLine}
          {/* The subscription ran out and the run went on on the person's key (lib/run-quota.ts). */}
          {data.thread.quota?.switched.map(item => <ThreadQuotaSwitchLine key={item.runId} switched={item} />)}
          {modelFallback.map(item => <ThreadModelFallbackNotice key={item.runId} item={item}
            retry={item.state !== 'switched' && canRetry ? () => { void send(t('retry'), true) } : undefined} retrying={sending} />)}
          {/* L3: the finishing message carries the thread's Artifact card. */}
          {!active && (view?.status ?? data.thread.status) === 'succeeded' && <ThreadArtifactCards runId={runId} />}
          {data.thread.feedbackEligible && <ThreadFeedback runId={runId} />}
        </>}
  </>
  // A layer's thread screen (slot `thread`) draws the conversation from these rows: each part as Mikka renders it, the
  // run's Agent as the author line, its steps as tool rows.
  const author = detail?.harness ? { id: detail.harness, name: harnessName(detail.harness), mark: <HarnessMark harness={detail.harness} /> } : undefined
  const at = (value: number | string | Date | undefined) => (value === undefined ? 0 : new Date(value).getTime()) || (data ? new Date(data.thread.createdAt).getTime() : Date.now())
  const entries: ThreadEntry[] = []
  if (data && (collect || (!bare && !transcriptOnly && detail))) {
    // The run's own rows read as one message until the person speaks; each person message starts the next.
    let open: Extract<ThreadEntry, { role: 'bot' }> | null = null
    const bot = (id: string, parts: ThreadEntryPart[], extra?: Partial<Extract<ThreadEntry, { role: 'bot' }>>) => {
      // What closes a run (its artifact cards, quota lines) joins its last message rather than starting an empty one.
      const last = entries.findLast((entry): entry is Extract<ThreadEntry, { role: 'bot' }> => entry.role === 'bot' && entry.id.startsWith(`${runId}:`))
      if (!open && id === 'tail' && last) { last.parts.push(...parts); return }
      // Its copy action is the newest words'.
      if (open) { open.parts.push(...parts); if (extra?.streaming) open.streaming = true; if (extra?.actions) open.actions = extra.actions; return }
      open = { id: `${runId}:${id}`, role: 'bot', at: at(extra?.at), parts: [...parts], ...(author ? { author } : {}), ...extra }
      entries.push(open)
    }
    // A later attempt's status line says nothing unless it is stopping (the thread-header slot): no empty row for it.
    if (!attempt || attempt.first || stopRequested) bot('status', [{ kind: 'text', text: '', node: <ThreadStatusLine pauseReason={view?.pauseReason} status={view?.status ?? data.thread.status} outcome={displayOutcome} stopping={stopRequested} waiting={question === 'waiting'} startedAt={new Date(data.thread.createdAt).toISOString()} dispatchedBy={detail?.agentName || null}
      issueId={issueId} runId={runId} harness={detail?.harness ?? null} {...(attempt ? { attempt: { ...attempt, harness: detail?.harness ?? null, prompt: data.thread.prompt.trim() || null } } : {})} /> }])
    if (!attempt && data.thread.prompt.trim()) { open = null; entries.push({ id: `${runId}:prompt`, role: 'person', at: at(data.thread.createdAt), text: data.thread.prompt.trim() }) }
    if (!attempt && data.thread.hasInstructions) bot('instructions', [{ kind: 'text', text: '', node: <ThreadInstructions issueId={issueId} runId={runId} mine={data.thread.ownedByCurrentUser} /> }])
    for (const item of items) {
      if (item.kind === 'person') { open = null; entries.push({ id: `${runId}:${item.id}`, role: 'person', at: at(item.at), text: item.text }); continue }
      const part: ThreadEntryPart = item.kind === 'agent' ? { kind: 'text', text: item.text, node: <div {...{ [QUOTE_SOURCE_ATTR]: '' }}><AgentMarkdown text={item.text} isStreaming={active} /></div> }
        : item.kind === 'steps' ? { kind: 'tools', id: `${runId}:${item.id}`, tools: item.steps.map(step => ({ id: step.id, label: step.name, status: step.failed ? 'failed' as const : 'done' as const,
          ...(step.ms !== undefined ? { ms: step.ms } : {}), ...(step.detail ? { note: step.detail } : {}), ...(step.output ? { detail: step.output.slice(0, 2000) } : {}) })) }
        : item.kind === 'error' ? { kind: 'error', text: item.text }
        : { kind: 'text', text: '', node: item.kind === 'computer'
          ? <ComputerCard botId={item.botId} runId={item.runId} task={item.task} state={active ? 'working' : (view?.status ?? data.thread.status) === 'succeeded' ? 'done' : 'failed'} />
          : <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground" data-slot="thread-stages">{item.stages.map((stage, index) => <span key={index} className={cn(!stage.ok && 'text-destructive-foreground')}>
            {t(`stages.${stage.stage}`)} {t('stages.duration', { seconds: (stage.ms / 1000).toFixed(1) })} {stage.ok ? '✓' : '✗'}</span>)}</p> }
      bot(item.id, [part], { ...(item.kind === 'agent' ? { actions: <MessageActions className={cn('self-start', HOVER_ACTIONS)}><CopyAction text={item.text} /></MessageActions> } : {}), ...(active && item === items.at(-1) ? { streaming: true } : {}) })
    }
    if (failure && !providerExplained) bot('failure', [{ kind: 'error', text: failureText.message ?? '', actions: <>
      {failureText.code && <RunErrorDetails code={failureText.code} />}
      {canRetry && <Button variant="outline" size="xs" className="shrink-0 pointer-coarse:h-11" disabled={sending} onClick={() => { void send(t('retry'), true) }}>{t('retry')}</Button>}
    </> }])
    const tail = <>
      {data.thread.quota?.switched.map(item => <ThreadQuotaSwitchLine key={item.runId} switched={item} />)}
      {modelFallback.map(item => <ThreadModelFallbackNotice key={item.runId} item={item} retry={item.state !== 'switched' && canRetry ? () => { void send(t('retry'), true) } : undefined} retrying={sending} />)}
      {!active && (view?.status ?? data.thread.status) === 'succeeded' && <ThreadArtifactCards runId={runId} />}
      {data.thread.feedbackEligible && <ThreadFeedback runId={runId} />}
    </>
    if (data.thread.quota?.switched.length || modelFallback.length || (!active && (view?.status ?? data.thread.status) === 'succeeded') || data.thread.feedbackEligible) bot('tail', [{ kind: 'text', text: '', node: tail }])
    if (active && !items.length) bot('waiting', [], { streaming: true })
  }
  if (!readRejected) for (const row of localMessages) entries.push({ id: row.id, role: 'person', at: row.at, text: row.text,
    status: row.phase === 'accepted' ? 'sent' : row.phase, deliveryMessage: row.error,
    ...(row.phase === 'failed' && (!replyBlocked || row.review) ? { onRetry: () => { void send(undefined, undefined, row) } } : {}) })
  for (const entry of entries) {
    if (entry.role === 'person' && /\[\[(?:issue|run|chat):|https:\/\/github\.com\//i.test(entry.text)) entry.body = <PersonReferences text={entry.text} />
  }
  // Re-publish the admitted read itself. Identical message lengths or tool
  // counts do not prove the content, grant or attempt result is unchanged.
  useEffect(() => { if (collect) collect(runId, entries) }, [collect, runId, data, active, canRetry, sending, view?.status, retryLabel, delivery.rows]) // eslint-disable-line react-hooks/exhaustive-deps
  if (collect) return null
  if (transcriptOnly) return <div data-attempt-section={runId} className="flex flex-col gap-3">{transcriptBody}</div>
  const recorded = data?.context?.composerModel
  const currentModel = recorded?.served || recorded?.selected
  const pickerEnabled = issueId && data?.live?.viewerId && !active && !question && !replyBlocked && !changeRequest &&
    (detail?.harness === 'codex' || detail?.harness === 'claude_code')
  const modelControl = data?.thread.ownedByCurrentUser ? <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
    {pickerEnabled && issueId && <BotModelPicker botId={null} thread={{ scope: JSON.stringify([data?.live?.viewerId, issueId, liveRunId]),
      load: () => getThreadContinuationModels(issueId, liveRunId), selected: pickedModel ? threadModelKey(pickedModel) : null, choose: id => setPickedModel(choiceFromMenu(id)) }} />}
    {currentModel ? <ModelLabel model={currentModel} /> : t('composerModelUnknown')}
    {recorded?.served && recorded.selected && recorded.served !== recorded.selected &&
      <span>{t('composerModelRequested', { model: recorded.selected })}</span>}
  </span> : undefined
  const referenceWorkspace = liveRuns.find(run => run.id === liveRunId)?.workspaceId
  const references = referenceWorkspace && data?.thread.ownedByCurrentUser ? <ThreadReferencePicker draft={draft}
    workspaceId={referenceWorkspace} input={inputRef} onChange={setDraft} /> : null
  const conversation = !bare && detail ? <ThreadScreen botId={null} name={title} mark={author?.mark ?? null} entries={data ? [...beforeEntries ?? [], ...entries, ...afterEntries ?? []] : null}
    working={working} onStop={working && canStop ? () => { void stop() } : undefined}
    composer={{ ref: inputRef, model: modelControl, label: replyBlocked ? t('checkEnded') : t('composer', { agent: harnessLabel(threadComposerHarness(detail.harness, liveRunId, modelFallback)) }), value: draft, onChange: setDraft, onSubmit: () => { void send() },
      attachmentScope: { kind: 'thread', id: liveRunId }, sending: sending || stopPending, editableWhileSending: true, submitDisabled: changeRequest ? false : replyBlocked || stopRequested || question === 'resuming',
      running: working || (question === 'resuming' && !data?.thread.questionWake), thread: true }}
    pending={[...changeRequest ? [{ id: 'change-request', name: changeRequest.label, onRemove: changeRequest.onCancel }] : [], ...replyQuote ? [{ id: 'reply-quote', name: replyQuote, onRemove: () => setReplyQuote(null) }] : []]}
    notices={<>
      {references}
      {data?.thread.quota?.paused && <ThreadQuotaPausedCard paused={data.thread.quota.paused} onContinued={() => { void mutate(); void mutateCache(['issue-threads', issueId]) }} />}
      {sendFailed && <FieldError className="px-3 text-xs">{sendFailed}</FieldError>}
      {stopFailed && <div role="alert" className="flex items-center gap-2 px-3 text-xs"><span className="text-destructive-foreground">{t('stopFailed')}</span><Button variant="ghost" size="sm" className="min-w-22 max-sm:h-11" onClick={() => { void stop() }}>{t('retryStop')}</Button></div>}
    </>}
    questions={[]} onAnswer={async () => ({ status: 'unavailable', error: '' })} running={0} onOpenTask={() => onOpenTask?.()} onOpenInbox={() => navigate({ section: 'suggestions' })} /> : <>
    <div ref={transcript} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
      {before}
      <div data-attempt-section={runId} className="flex flex-col gap-3">{transcriptBody}</div>
      {after}
    </div>
    {data?.thread.quota?.paused && <div className="shrink-0 p-3">
      <ThreadQuotaPausedCard paused={data.thread.quota.paused} onContinued={() => { void mutate(); void mutateCache(['issue-threads', issueId]) }} />
    </div>}
    {/* R-10: an open thread always ends in the composer, finished or not. A message to an ended thread runs it
        again in the same thread (R-81); only a thread the viewer cannot see in full (no `detail`) has none. */}
    {detail && <div data-slot="thread-composer" className="flex shrink-0 flex-col gap-1 p-3">
      {/* Keep the draft editable while stop waits for the daemon; do not queue new work after stop. */}
      {references}
      <ChatComposer ref={inputRef} model={modelControl} label={replyBlocked ? t('checkEnded') : t('composer', { agent: harnessLabel(threadComposerHarness(detail.harness, liveRunId, modelFallback)) })} value={draft} onChange={setDraft} onSubmit={() => { void send() }} attachmentScope={{ kind: 'thread', id: liveRunId }}
        quote={changeRequest ? <QuoteChip slot="change-request-chip" text={changeRequest.label} icon={<MessageSquareDiff aria-hidden="true" className="size-3.5 shrink-0" />} onRemove={changeRequest.onCancel} />
          : replyQuote ? <QuoteChip slot="reply-quote-chip" text={replyQuote} onRemove={() => { setReplyQuote(null); inputRef.current?.focus() }} /> : undefined}
        sending={sending || stopPending} editableWhileSending submitDisabled={changeRequest ? false : replyBlocked || stopRequested || question === 'resuming'} running={working || (question === 'resuming' && !data?.thread.questionWake)} thread onStop={working && canStop ? () => { void stop() } : undefined} />
      {sendFailed && <FieldError className="px-3 text-xs">{sendFailed}</FieldError>}
      {stopFailed && <div role="alert" className="flex items-center gap-2 px-3 text-xs"><span className="text-destructive-foreground">{t('stopFailed')}</span><Button variant="ghost" size="sm" className="min-w-22 max-sm:h-11" onClick={() => { void stop() }}>{t('retryStop')}</Button></div>}
    </div>}
    </>
  // Esc inside the thread is ←; in its composer or another field it only leaves the field (decision 0301). A window opened from it keeps its own Esc.
  // data-own-scroll: the messages scroll inside and the composer stays at the bottom, so a frame whose one scroller
  // holds this panel (the official work area) gives it the scroller's height instead of growing with it.
  return <section ref={rootRef} aria-label={title} data-own-scroll="" className="flex h-full min-h-0 flex-col" onKeyDown={bare || !onBack ? undefined : event => closeOnEscape(event, headingRef.current, onBack)}>
    {!bare && <ThreadHeader issueId={issueId} runId={runId} title={title} headingRef={headingRef} onBack={onBack} onClose={onClose}
      onStop={canStop ? () => { void stop() } : null} onOpenTask={onOpenTask} wraps={!!acceptance}
      widen={widen ?? undefined} liveRunId={liveRunId} status={data?.thread.status ?? ''} acceptanceTaskId={acceptance?.id ?? null}
      place={detail ? <ThreadRunPlace issueId={issueId} runId={runId} status={view?.status ?? data?.thread.status ?? ''} harness={detail.harness} botName={detail.agentName} /> : null}
      acceptanceBadge={acceptance ? <AcceptanceStateBadge task={acceptance} /> : null}
      identity={data?.thread.ownedByCurrentUser ? <ThreadExecutionIdentity runId={liveRunId} /> : null}
      artifact={!readRejected ? <ThreadArtifactButton runId={runId} status={data?.thread.status ?? ''} taskId={acceptance?.id} /> : null}
      tabs={acceptance && !hasChanges ? <Tabs value={tab} onValueChange={value => setTab(value as ThreadTab)} className="shrink-0 max-sm:order-last max-sm:w-full">
        <TabsList className="max-sm:w-full"><TabsTrigger value="chat">{t('chatTab')}</TabsTrigger><TabsTrigger value="acceptance">{t('acceptanceTab')}</TabsTrigger></TabsList>
      </Tabs> : null} />}
    {/* With 改动 the tabs get their own row: the side panel has no room for them beside the title. */}
    {!bare && hasChanges && <div className="flex shrink-0 items-center px-3 pt-2">
      <Tabs value={tab} onValueChange={value => setTab(value as ThreadTab)}>
        <TabsList><TabsTrigger value="chat">{t('chatTab')}</TabsTrigger><TabsTrigger value="changes" className="gap-1.5"><ChangesTabLabel changes={changes.state === 'ready' ? changes.changes : null} /></TabsTrigger>{acceptance && <TabsTrigger value="acceptance">{t('acceptanceTab')}</TabsTrigger>}</TabsList>
      </Tabs>
    </div>}
    {viewingChanges ? (changes.state === 'ready'
      ? <ThreadChangesPane stateKey={`thread:${runId}:changes`} changes={changes.changes} />
      : <p className="p-4 text-sm text-muted-foreground">{t('changesTooLarge')}</p>)
    : accepting && acceptance ? <div className="flex min-h-0 flex-1 flex-col"><FactoryAcceptancePane task={acceptance} onOpenThread={onOpenThread} /></div> : conversation}
    {detail && <SelectionQuote root={rootRef} onQuote={text => { setReplyQuote(text); inputRef.current?.focus() }} />}
  </section>
}
