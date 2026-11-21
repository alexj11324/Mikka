'use client'

import { ThreadReadEnd } from '@/components/workspace/thread-read-end'

import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import type { ThreadDeliveryMode } from '@/lib/thread-delivery'
import { useViewScroll, useViewState } from '@/lib/hooks/view-state'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { unstable_serialize, useSWRConfig } from 'swr'
import { useMessages, useTranslations } from '@/lib/intl/i18n-client'
import { toast } from 'sonner'
import { ChevronDown } from '@/components/icons'
import { getThreadInstructions, stopRun, getThreadContinuationModels } from '@/app/actions/agents'
import { useThreadChanges } from '@/hooks/use-thread-run-reads'
import { useIssueThreadRead } from '@/hooks/use-issue-thread-read'
import { useActionError } from '@/lib/use-action-error'
import { sendReviewChange, type ReviewChangeTarget } from '@/lib/factory/review-change'
import { RequestError } from '@/lib/factory/browser-request'
import { useChatDelivery, useThreadReplyCommand, type ChatSubmission } from '@/lib/hooks/chat-delivery'
import { prepareThreadReply, type ThreadReplySubmission } from '@/lib/thread-submission-input'
import { runFailureText, runIsActive, runIsWorking, runStopTimeoutRemaining, threadItems, threadStepOutput } from '@/lib/issue-run-conversation'
import { ThreadReplyVersions } from './thread-reply-versions'
import { ThreadExecutionIdentity } from './thread-execution-identity'
import { ThreadRunPlace } from './thread-run-place'
import { acceptedProducerOutcome, isThreadRun, threadQuestionView } from '@/lib/issue-threads'
import { threadComposerHarness } from '@/lib/run-model-fallback-view'
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
import { issueKeys } from '@/lib/swr/keys'
import type { IssueView } from '@/app/actions/issues'
import type { IssueWorkSnapshot } from '@/app/actions/agents'
import { harnessLabel, threadTopologyKey, type IssueThreadsRead } from './issue-threads'
import { BotModelPicker } from '@/components/coordinator/bot-model-picker'
import { ChatComposerAttachment } from '@/components/coordinator/chat-composer'
import { choiceFromMenu, threadModelKey, type ThreadModelChoice } from '@/lib/thread-model-choice'
import { ThreadScreen } from '@ui-slot/thread'
import { useConversationPanels } from '@/components/coordinator/conversation-panels-context'
import type { ThreadEntry, ThreadEntryPart, ThreadHost } from '@/components/slots/thread-contract'
import { atTheirTime } from '@/lib/thread-child-entries'
import { HarnessMark, harnessName, ProviderMark } from '@/components/labels/entity-labels'
import { PersonAvatar } from '@/components/person-avatar'
import { BotAvatar, COORDINATOR_AVATAR } from '@/components/nav/bot-avatar'
import { MikkaMark } from '@/components/brand/mikka-mark'
import { navigate, openTask } from './workspace-navigation'
import { ThreadHeader } from './thread-header'
import { ThreadStatus } from './thread-status-icon'
import { PersonReferences, ThreadReferencePicker } from './thread-references'
import { ThreadOutlineIndex } from './thread-outline-index'
import { AgentCitationsContext, CitationSources, useLinkPreviews, type AgentCitations } from './agent-citations'
import { useLiveCitations } from '@/components/coordinator/use-live-citations'
import { modelDisplayName } from '@/lib/model-display-name'
import { modelProvider } from '@/lib/execution-settings-view'
import { threadOutline } from '@/lib/thread-outline'
import { useRightColumnWiden } from './right-column-widen'
import { RunErrorDetails, useRunErrorText } from './run-error-text'
import { CreditsRefusalActions } from '@/components/billing/paywall'
import { hostedRefusal } from '@/lib/billing/hosted-usage'
import { ThreadModelFallbackNotice, ThreadQuotaPausedCard, ThreadQuotaSwitchLine } from './thread-quota'
import { cn } from '@/lib/utils'
import { ThreadArtifactChips } from './artifact-review'
import { ArtifactIcon } from '@/components/icons/artifact-icon'
import type { ThreadViewAction } from '@/components/slots/thread-header-contract'
import { AcceptanceStateBadge, useAcceptanceTasks } from './factory-acceptance'
import { FactoryAcceptancePane } from './factory-acceptance-pane'
import { ThreadChangesPane } from './thread-changes'
import { ThreadArtifactsPane, ThreadArtifactsReader, type ThreadArtifactsRead } from './thread-artifacts'

import { ThreadFeedback } from './self-improvement'
import { InlineLoadError } from '@/components/load-error'
import { FieldError } from '@/components/ui/field'
import { closeOnEscape, useFocusReturn } from '@/hooks/use-focus-return'
import { heldRevision } from '@/lib/live/revisions'
import { useLiveKey, useLiveKeys } from '@/hooks/use-live-key'
import { readAccessFailure } from '@/lib/swr/persistent-cache'

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
      : <div data-slot="thread-instructions" className="w-full min-w-0 rounded-xl border border-rule px-3 py-2 text-xs/5 whitespace-pre-wrap break-words text-muted-foreground"><CollapsibleMessage>{text}</CollapsibleMessage></div>)}
  </div>
}

/**
 * An open thread: a conversation between people and the agent running it (R-62, R-10).
 * It sits in the right column beside the chat or the task, wherever it was opened from
 * (R-82). Its header leads with ←, back to the list it came from (Esc does the same);
 * the state is the badge under it, so the header has no status icon. The byline names
 * the bot that dispatched it.
 */
type ThreadTab = 'chat' | 'changes' | 'acceptance' | 'artifacts'
type IssueThreadPanelProps = {
  host?: ThreadHost
  issueId: string | null
  runId: string
  onBack?: () => void
  onClose?: () => void
  /** The window supplies its own header and tabs. */
  bare?: boolean
  initialTab?: ThreadTab
  onOpenThread?: (runId: string) => void
  onOpenTask?: () => void
  name?: string
  changeRequest?: ThreadChangeRequest
  focusRunId?: string
  transcriptOnly?: boolean
  attempt?: { n: number; first: boolean; taskTitle?: string; stage?: string }
  collect?: (runId: string, entries: ThreadEntry[]) => void
  beforeEntries?: ThreadEntry[]
  afterEntries?: ThreadEntry[]
  childEntries?: ThreadEntry[]
  openSender?: () => void
}

export type ThreadChangeRequest = ReviewChangeTarget & { onCancel: () => void }

export function IssueThreadPanel(props: IssueThreadPanelProps) {
  // Drafts, in-flight callbacks and retry deadlines belong to exactly one run.
  return <ThreadPanel key={props.runId} {...props} />
}

function ThreadPanel({ host = 'embedded', issueId, runId, onBack, onClose, bare = false, initialTab = 'chat', onOpenThread, onOpenTask, name: listedName, changeRequest, focusRunId, transcriptOnly = false, attempt, collect, beforeEntries, afterEntries, childEntries, openSender }: IssueThreadPanelProps) {
  const t = useTranslations('IssueThreads')
  const tArtifact = useTranslations('ArtifactsPage')
  const messages = useMessages()
  const runErrorText = useRunErrorText()
  const refusalText = useTranslations('Billing.refusal')
  const { mutate: mutateCache, cache } = useSWRConfig()
  // The task owns its mounted collection. Older servers still use the thread-list cache.
  const listKey = useCallback(() => {
    if (issueId && cache.get(unstable_serialize(issueKeys.detail(issueId)))?.data?.taskWork) return issueKeys.detail(issueId)
    return ['issue-threads', issueId] as const
  }, [cache, issueId])
  const refreshLists = useCallback(() => {
    void mutateCache(listKey())
    if (issueId) void mutateCache(threadTopologyKey(issueId))
  }, [issueId, listKey, mutateCache])
  const key = ['issue-thread', issueId, runId]
  const { data: read, error, mutate } = useIssueThreadRead(issueId, runId)
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
  const [olderState, setOlderState] = useState<'idle' | 'loading' | 'failed'>('idle')
  const [historyPrepend, setHistoryPrepend] = useState(0)
  const olderBusy = useRef(false)
  const olderAnchor = useRef<{ box: HTMLElement; node?: HTMLElement; offset: number; height: number; top: number } | null>(null)
  const olderLabel = useTranslations('Common')('loadMore')
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
  // A thread whose candidate waits for acceptance offers the acceptance view in More.
  const { tasks: acceptanceTasks, allTasks } = useAcceptanceTasks(transcriptOnly ? null : issueId)
  // Keep the pane on the addressed producer; its status can follow an accepted continuation.
  const acceptance = readRejected ? undefined : acceptanceTasks.find(task => task.candidateRunId === runId)
  const [tab, setTab] = useState<ThreadTab>(initialTab)
  const accepting = !bare && Boolean(acceptance) && tab === 'acceptance'
  // 改动 (Figma 820:4843): the agent's work tree diff, read-only, once the run saved one.
  const view = data ? threadQuestionView(data.thread) : null
  const { data: changes } = useThreadChanges(issueId, bare || transcriptOnly ? null : runId, view?.status)
  const hasChanges = !readRejected && !!changes && changes.state !== 'none'
  const viewingChanges = hasChanges && tab === 'changes'
  // The main thread surface reads contextual Artifact evidence.
  const tabbed = !bare && !transcriptOnly && !collect
  // A conversation the page hands its work area to (FRAME_OWNS_PANEL) draws the Overview and the browser as tabs of
  // that area instead of a column beside it. Only the centre page provides this; a thread in the right column, a
  // task's own pane and the Artifact window are outside the provider and get none, so nothing stands beside them.
  const panels = useConversationPanels()
  const [artifacts, setArtifacts] = useState<ThreadArtifactsRead | null>(null)
  const hasArtifacts = tabbed && !readRejected && (artifacts?.count ?? 0) > 0
  const viewingArtifacts = hasArtifacts && tab === 'artifacts'
  const extraArtifactCount = hasArtifacts && artifacts ? artifacts.groups.captures.length + artifacts.groups.pullRequests.length : 0
  // An evidence link opens its thread on Artifact, once; the person can move to another tab after.
  const linked = useRef<string | null>(null)
  const linkedFocus = artifacts?.focusId ?? null
  useEffect(() => {
    if (!linkedFocus || linked.current === linkedFocus) return
    linked.current = linkedFocus
    setTab('artifacts')
  }, [linkedFocus, setTab])
  const transcript = useViewScroll<HTMLDivElement>(`thread:${runId}:chat`, !!data && !viewingChanges && !accepting && !viewingArtifacts)
  const olderPosition = data?.historyPage?.before
  async function loadOlder(box = transcript.current as HTMLElement | null) {
    const page = data?.historyPage
    if (!page?.before || olderBusy.current) return
    olderBusy.current = true
    setOlderState('loading')
    try {
      const { getOlderIssueThread } = await import('@/app/actions/agents')
      const older = await getOlderIssueThread(issueId, runId, page.before)
      if (box) {
        const top = box.getBoundingClientRect().top
        const ids = new Set(items.map(item => `${runId}:${item.id}`))
        const node = [...box.querySelectorAll<HTMLElement>('[data-thread-message-id]')]
          .find(row => ids.has(row.dataset.threadMessageId ?? '') && row.getBoundingClientRect().bottom > top)
        olderAnchor.current = { box, node, offset: node ? node.getBoundingClientRect().top - top : 0,
          height: box.scrollHeight, top: box.scrollTop }
      }
      await mutate(current => {
        if (current?.historyPage?.before !== page.before || current.historyPage.chain !== older.chain) {
          olderAnchor.current = null
          return current
        }
        return {
          ...current, chunks: [...older.chunks, ...current.chunks], messages: [...older.messages, ...current.messages],
          historyPage: { ...current.historyPage, before: older.before },
        }
      }, { revalidate: false })
      setOlderState('idle')
      setHistoryPrepend(value => value + 1)
      void mutate()
    } catch (failure) {
      olderAnchor.current = null
      setOlderState('failed')
      if (readAccessFailure(failure) || failure instanceof RequestError && failure.code === 'runNotFound') void mutate()
    } finally {
      olderBusy.current = false
    }
  }
  useLayoutEffect(() => {
    const anchor = olderAnchor.current
    if (!anchor) return
    olderAnchor.current = null
    const { box, node, offset, height, top } = anchor
    if (!box.isConnected) return
    const restore = () => {
      if (!box.isConnected) return
      box.scrollTop = node?.isConnected
        ? box.scrollTop + node.getBoundingClientRect().top - box.getBoundingClientRect().top - offset
        : top + box.scrollHeight - height
    }
    if (!collect) { restore(); return }
    // The collector publishes its rows to the shared transcript in a passive effect.
    const frame = requestAnimationFrame(restore)
    return () => cancelAnimationFrame(frame)
  }, [olderPosition, collect])
  const [draft, setDraft] = useViewState(`thread:${runId}:draft`, '')
  const feedback = useTranslations('Coordinator')
  const quoteLabel = useTranslations('AiElements.message')('quote')
  const writer = useThreadReplyCommand()
  const [deliveryMode, setDeliveryMode] = useViewState<ThreadDeliveryMode>('thread:delivery-mode', 'queue')
  const modes = data?.delivery?.modes ?? []
  const selectedMode = modes.includes(deliveryMode) ? deliveryMode : modes[0]
  const delivery = useChatDelivery<ChatSubmission & { delivery?: ThreadDeliveryMode; review?: ReviewChangeTarget; runId: string; expectedOwnerId?: string; expectedWorkspaceId?: string; modelChoice?: ThreadModelChoice }>(`thread:${runId}`, feedback('sendUncertain'))
  const sendLock = useRef(false)
  const [pickedModel, setPickedModel] = useViewState<ThreadModelChoice | null>(`thread:${runId}:next-model`, null)
  const [submission, setSubmission] = useViewState<ThreadReplySubmission | null>(`thread:${runId}:submission`, null)
  // Words picked from the agent's reply with 引用: they head the next message as quote lines.
  const [replyQuote, setReplyQuote] = useViewState<string | null>(`thread:${runId}:quote`, null)
  const rootRef = useRef<HTMLElement>(null)
  const [sending, setSending] = useState(false)
  // As Capy, a finished run's steps fold under its activity line; the line opens them.
  const [stepsOpen, setStepsOpen] = useState(false)
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
  const question = view?.question ?? null
  const liveRunId = view?.runId ?? runId
  const active = !!view && question !== 'resuming' && runIsActive(view.status)
  // Only a run that is generating or running turns send into stop; one waiting for an answer sends (N1).
  const working = active && runIsWorking(view.status)
  // Stop was asked for; the run keeps its live status until the daemon ends it.
  const requestedAt = stopAttempt ?? (data?.thread.stopRequestedAt ? new Date(data.thread.stopRequestedAt).getTime() : null)
  const stopRequested = active && (requestedAt !== null || !!view?.stopping)
  const stopPending = stopRequested && !stopFailed
  const confirmedIds = useMemo(() => new Set([...(data?.messages?.flatMap(message => message.submissionId ? [message.submissionId] : []) ?? []), ...(data?.delivery?.queued.map(row => row.requestId) ?? [])]), [data?.messages, data?.delivery])
  const localMessages = delivery.rows.filter(row => !confirmedIds.has(row.id))
  useEffect(() => {
    if (delivery.rows.some(row => confirmedIds.has(row.id))) delivery.setRows(current => current.filter(row => !confirmedIds.has(row.id)))
  }, [confirmedIds, delivery.rows, delivery.setRows])
  const items = useMemo(() => data ? threadItems(data.chunks, data.messages, runId) : [], [data, runId])
  // The jump index, from the items already built: never a second fold of the stream.
  const outline = threadOutline(items)
  // A failed run says why under the stage that stopped, else at the end of the conversation.
  const failure = data && view ? runFailureText(view.status, data.thread.questionWake ? actionError('threadRecoveryUnavailable') : data.thread.error) : null
  const modelFallback = data?.thread.modelFallback?.filter(item => item.state === 'switched' || item.runId === liveRunId) ?? []
  const providerExplained = data?.thread.modelFallbackPending || modelFallback.some(item => item.runId === liveRunId)
  // A message to an ended thread runs it again in the same thread (R-81): 重试 is that message, one tap (N2).
  const readOnly = transcriptOnly || !data?.thread.ownedByCurrentUser || !detail
  const replyBlocked = readOnly || data?.thread.replyAvailable === false
  const composerUnavailable = replyBlocked && !changeRequest
  const canRetry = !transcriptOnly && !!failure && !!data?.thread.detail && data.thread.ownedByCurrentUser && data.thread.retryAvailable && !runIsActive(view?.status ?? '')
  const creditsRefusal = data?.thread.error ? hostedRefusal(data.thread.error) ?? (data.thread.error.includes('cloud_machine_unfunded') ? 'cloud_machine_unfunded' : null) : null
  const failureText = creditsRefusal && creditsRefusal !== 'cloud_machine_unfunded' ? { message: refusalText('points_exhausted'), code: null } : runErrorText(failure)
  useEffect(() => {
    if (!active || requestedAt === null) return
    const timer = setTimeout(() => setStopFailed(true), runStopTimeoutRemaining(requestedAt))
    return () => clearTimeout(timer)
  }, [active, requestedAt])
  const previousStatus = useRef<string | undefined>(undefined)
  const threadStatus = view ? [view.status, view.stopping, question].join(':') : undefined
  useEffect(() => {
    const previous = previousStatus.current
    previousStatus.current = threadStatus
    if (!transcriptOnly && previous && threadStatus && previous !== threadStatus) refreshLists()
  }, [threadStatus, refreshLists, transcriptOnly])
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
    const command = previous ?? { ...(selectedMode && !retry && !review ? { delivery: selectedMode } : {}), id: saved.requestId, runId: saved.runId, text: words, at: Date.now(), ...(saved.modelChoice ? { modelChoice: saved.modelChoice } : {}), ...(review ? { review: { label: review.label, binding: review.binding } } : {}),
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
      void mutate().catch(() => undefined); refreshLists()
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
    const where = listKey()
    const stopping = (read: IssueThreadsRead) => read.threads.map(thread => thread.id === runId
      ? { ...thread, stopping: true, continuation: thread.continuation && { ...thread.continuation, stopping: true } }
      : thread)
    if (where[0] === 'issue') {
      void mutateCache<IssueView & { taskWork?: IssueWorkSnapshot }>(where, read => read?.taskWork
        ? { ...read, taskWork: { ...read.taskWork, threads: stopping(read.taskWork) } } : read, { revalidate: false })
    } else {
      void mutateCache<IssueThreadsRead>(where, read => read && { ...read, threads: stopping(read) }, { revalidate: false })
    }
    try { await stopRun(liveRunId); void mutate(); refreshLists() }
    catch {
      // A late response from an earlier request must not cancel a retry.
      if (stopAttemptRef.current === attempt) {
        stopAttemptRef.current = null
        setStopAttempt(null); setStopFailed(true)
        refreshLists()
      }
    }
  }
  const canStop = active && !!data?.thread.ownedByCurrentUser && !sending && !stopPending
  const title = (!readRejected && listedName) || (detail?.name ?? t('title'))
  // A run opened from its task's 活动 scrolls to its section in the joined conversation (TaskConversation), the newest
  // run's own section included. It waits until no section above still shows its skeleton: a transcript that loads
  // after the scroll would push the opened run back out of view.
  useEffect(() => {
    const root = rootRef.current
    if (!focusRunId || !root) return
    const reveal = () => {
      const section = root.querySelector(`[data-attempt-section="${CSS.escape(focusRunId)}"]`)
      if (!section || root.querySelector('[data-thread-loading]')) return false
      section.scrollIntoView({ block: 'start' })
      return true
    }
    if (reveal()) return
    const observer = new MutationObserver(() => { if (reveal()) observer.disconnect() })
    observer.observe(root, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [focusRunId, runId])
  const readEnd = data?.readReceipts?.some(row => row.unread) ? <ThreadReadEnd receipts={data.readReceipts} /> : null
  const versionControl = (item: (typeof items)[number]) => {
    if (!issueId || !data?.thread.ownedByCurrentUser || !['person','agent'].includes(item.kind)) return null
    const base = {issueId,runId,canRun:!active && data.thread.replyAvailable && !question,refresh:()=>{void mutate()}}
    if (item.kind === 'person' && item.mine) {
      const source = data.messages.find(row=>row.id===item.id && row.editable)
      return source?.sourceRunId ? <ThreadReplyVersions {...base} anchorRunId={source.sourceRunId} anchorKey={item.id} operation="edit" text={item.text} /> : null
    }
    if (item.kind !== 'agent') return null
    const part = item.id.slice('text:'.length)
    const nested = data.live?.runs.find(run=>part.startsWith(run.id+':'))
    const sourceRunId = nested?.id ?? (data.historyPage?.chain === runId ? runId : data.chunkCursor?.runs === 1 ? data.chunkCursor.runId : null)
    return sourceRunId ? <ThreadReplyVersions {...base} anchorRunId={sourceRunId} anchorKey={nested ? part.slice(nested.id.length+1) : part} operation="rerun" text={item.text} /> : null
  }
  const waiting = !data && (error
    ? <InlineLoadError message={readFailedMessage} retryLabel={retryLabel} onRetry={() => { void mutate() }} />
    : <div role="status" aria-label={t('loading')} data-thread-loading className="flex flex-col gap-3"><Skeleton className="h-5 w-40" /><Skeleton className="ml-auto h-12 w-3/4" /><Skeleton className="h-12 w-2/3" /></div>)
  const citationTexts = items.flatMap(item => item.kind === 'agent' || item.kind === 'person' ? [item.text] : [])
  const previews = useLinkPreviews(citationTexts)
  const citationBase = useMemo<AgentCitations>(() => ({ sources: {}, previews, onOpenIssue: openTask }), [previews])
  const citations = useLiveCitations(citationTexts, citationBase)
  // A layer's thread screen (slot `thread`) draws the conversation from these rows: each part as Mikka renders it, the
  // run's Agent as the author line, its steps as tool rows.
  // As Capy, an Agent's reply is its words alone: the author stays for screen readers and the switch of Agent, unseen.
  const author = detail?.harness ? { id: detail.harness, name: harnessName(detail.harness), mark: <HarnessMark harness={detail.harness} />, quiet: true } : undefined
  const at = (value: number | string | Date | undefined) => (value === undefined ? 0 : new Date(value).getTime()) || (data ? new Date(data.thread.createdAt).getTime() : Date.now())
  const entries: ThreadEntry[] = []
  if (data) {
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
    // Where the task's conversation reaches a new Factory stage, one quiet line names it, as Warp marks a stage; the
    // steps of that stage follow as the run's own rows.
    if (attempt?.stage) {
      const stage = (messages.GroupTask.stage as Record<string, string>)[attempt.stage] ?? attempt.stage
      entries.push({ id: `${runId}:stage`, role: 'bot', at: at(data.thread.createdAt), event: true, parts: [{ kind: 'text', text: stage, node:
        <p role="separator" aria-label={stage} data-event-line="" data-factory-stage={attempt.stage} className="text-center text-xs text-muted-foreground">{stage}</p> }] })
    }
    // Who sent the run off: its Bot, or Mikka when no Bot did (a Factory review or verify; the read then falls back to the
    // Agent's own name). What it was asked is that sender's first message, as a chat shows it, not a muted line.
    const sender = detail?.agentName && detail.agentName !== harnessName(detail.harness) && detail.agentName !== detail.harness
      ? { id: `bot:${detail.agentName}`, name: detail.agentName, mark: <BotAvatar {...(detail.bot ?? COORDINATOR_AVATAR)} size="message" still /> }
      : { id: 'mikka', name: 'Mikka', mark: <MikkaMark />, ...(openSender ? { onOpen: openSender } : {}) }
    const asked = data.thread.prompt.trim()
    // Mikka's ask to a review or verify comes first too, before the run's own status line.
    const independentCheck = !isThreadRun(data.thread)
    if ((attempt?.first || (!attempt && independentCheck)) && asked) entries.push({ id: `${runId}:dispatch`, role: 'bot', at: at(data.thread.createdAt), author: sender,
      parts: [{ kind: 'text', text: asked, node: <p className="whitespace-pre-wrap wrap-anywhere">{asked}</p> }] })
    // As Capy, how the run went is one quiet centred line between rules where its work starts: 「工作了 2 分 3 秒」,
    // 「正在工作 · 12 秒」, 「在等你回复」; it replaces the old 「完成 · 开始于 … · Agent」 status line (Alex, 2026-11-15).
    {
      const status = view?.status ?? data.thread.status
      const outcome = acceptedProducerOutcome(data.thread, issueId, allTasks)
      const waitingForReply = question === 'waiting' || status === 'waiting_input'
      // The list's fallback group for an unjudged run is not a request for input.
      const showBadge = !stopRequested && (waitingForReply || runIsActive(status) || status === 'failed' || status === 'paused' || outcome !== null)
      const started = new Date(data.thread.createdAt).getTime()
      const ended = data.thread.finishedAt ? new Date(data.thread.finishedAt).getTime() : Date.now()
      const seconds = Math.max(0, Math.round((ended - started) / 1000))
      const duration = seconds < 60 ? t('activityLine.seconds', { s: seconds })
        : seconds < 3600 ? (seconds % 60 ? t('activityLine.minutes', { m: Math.floor(seconds / 60), s: seconds % 60 }) : t('activityLine.minutesOnly', { m: seconds / 60 }))
        : t('activityLine.hours', { h: Math.floor(seconds / 3600), m: Math.floor(seconds / 60) % 60 })
      const line = stopRequested ? t('stopping') : waitingForReply ? t('activityLine.waiting')
        : active ? t('activityLine.working', { duration })
        : [t('activityLine.worked', { duration }), ...status === 'failed' ? [t('activityLine.failed')] : status === 'stopped' || status === 'cancelled' ? [t('activityLine.stopped')] : []].join(' · ')
      const folds = !active && items.some(item => item.kind === 'steps')
      entries.push({ id: `${runId}:activity`, role: 'bot', at: at(data.thread.createdAt), event: true, parts: [{ kind: 'text', text: line, node:
        <div data-attempt-section={runId} data-event-line="" data-activity-line="" className="flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground">
          {folds ? <Button type="button" variant="ghost" size="xs" aria-expanded={stepsOpen} onClick={() => setStepsOpen(value => !value)} className="text-muted-foreground">
            {line}<ChevronDown data-icon="inline-end" aria-hidden className={cn('transition-transform', stepsOpen && 'rotate-180')} />
          </Button> : <span role="status">{line}</span>}
          {showBadge && <ThreadStatus status={status} outcome={outcome} waiting={waitingForReply} icon={false} />}
          <ThreadOutlineIndex entries={outline} />
        </div> }] })
    }
    if (!attempt && asked && !independentCheck) { open = null; entries.push({ id: `${runId}:prompt`, role: 'person', at: at(data.thread.createdAt), text: asked }) }
    if (!attempt && data.thread.hasInstructions) bot('instructions', [{ kind: 'text', text: '', node: <ThreadInstructions issueId={issueId} runId={runId} mine={data.thread.ownedByCurrentUser} /> }])
    if (collect && olderPosition) {
      open = null
      entries.push({ id: `${runId}:older`, role: 'bot', event: true, at: at(data.thread.createdAt), parts: [{
        kind: 'text', text: '', node: <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" disabled={olderState === 'loading'} onClick={event => { void loadOlder(event.currentTarget.closest('[role="log"]')?.parentElement) }}>{olderLabel}</Button>
          {olderState === 'failed' && <span role="alert" className="text-destructive-foreground">{readFailedMessage}</span>}
        </div>,
      }] })
    }
    for (const item of items) {
      if (item.kind === 'steps' && !active && !stepsOpen) continue
      if (item.kind === 'person') {
        open = null
        const id = `${runId}:${item.id}`
        if (item.mine) entries.push({ id, role: 'person', at: at(item.at), text: item.text, actions: versionControl(item) })
        else {
          const files = splitChatFiles(item.text)
          entries.push({ id, role: 'bot', at: at(item.at),
            author: { id: `person:${item.author}`, name: item.author, mark: <PersonAvatar name={item.author} image={item.image} /> },
            actions: <MessageActions className={HOVER_ACTIONS}><CopyAction text={files.text} /></MessageActions>,
            parts: [{ kind: 'text', text: item.text, node: <AgentCitationsContext value={citations.settled}>
              <span data-thread-item={item.id}><PersonReferences text={files.text} /></span>
              <ChatFileCards files={files.files} sent />
            </AgentCitationsContext> }] })
        }
        continue
      }
      const part: ThreadEntryPart = item.kind === 'agent' ? { kind: 'text', text: item.text, node: <AgentCitationsContext value={citations.settled}><div {...{ [QUOTE_SOURCE_ATTR]: '' }}><AgentMarkdown text={item.text} isStreaming={active} /></div></AgentCitationsContext> }
        : item.kind === 'steps' ? { kind: 'tools', id: `${runId}:${item.id}`, tools: item.steps.map(step => ({ id: step.id, label: step.name, status: step.failed ? 'failed' as const : 'done' as const,
          ms: step.ms, note: step.detail ?? undefined, command: step.command, detail: threadStepOutput(step), exitCode: step.exitCode ?? undefined })) }
        : item.kind === 'error' ? { kind: 'error', text: item.text }
        : { kind: 'text', text: '', node: item.kind === 'computer'
          ? <ComputerCard botId={item.botId} runId={item.runId} task={item.task} state={active ? 'working' : (view?.status ?? data.thread.status) === 'succeeded' ? 'done' : 'failed'} />
          : <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground" data-slot="thread-stages">{item.stages.map((stage, index) => <span key={index} className={cn(!stage.ok && 'text-destructive-foreground')}>
            {t(`stages.${stage.stage}`)} {t('stages.duration', { seconds: (stage.ms / 1000).toFixed(1) })} {stage.ok ? '✓' : '✗'}</span>)}</p> }
      bot(item.id, [part], { ...(item.kind === 'agent' ? { actions: <MessageActions className={cn('self-start', HOVER_ACTIONS)}><CopyAction text={item.text} />{versionControl(item)}<AgentCitationsContext value={citations.settled}><CitationSources text={item.text} /></AgentCitationsContext></MessageActions> } : {}), ...(active && item === items.at(-1) ? { streaming: true } : {}) })
    }
    if (failure && !providerExplained) bot('failure', [{ kind: 'text', text: failureText.message ?? '', node: <div data-slot="thread-failure" className="flex flex-wrap items-start gap-2">
      <FieldError>{failureText.message}</FieldError>
      {failureText.code && <RunErrorDetails code={failureText.code} />}
      {creditsRefusal && <CreditsRefusalActions />}
      {canRetry && <Button variant="outline" size="xs" className="shrink-0 pointer-coarse:h-11" disabled={sending} onClick={() => { void send(t('retry'), true) }}>{t('retry')}</Button>}
    </div> }])
    const tail = <>
      {data.thread.quota?.switched.map(item => <ThreadQuotaSwitchLine key={item.runId} switched={item} />)}
      {modelFallback.map(item => <ThreadModelFallbackNotice key={item.runId} item={item} retry={item.state !== 'switched' && canRetry ? () => { void send(t('retry'), true) } : undefined} retrying={sending} />)}
      {!active && <ThreadArtifactChips runId={runId} documents={artifacts?.documents} />}
      {extraArtifactCount > 0 && <Button variant="secondary" size="sm" onClick={() => setTab('artifacts')}><ArtifactIcon data-icon="inline-start" />{tArtifact('threadEntry', { count: extraArtifactCount })}</Button>}
      {data.thread.feedbackEligible && <ThreadFeedback runId={runId} />}
      {readEnd}
    </>
    if (readEnd || data.thread.quota?.switched.length || modelFallback.length || !active || extraArtifactCount > 0 || data.thread.feedbackEligible) bot('tail', [{ kind: 'text', text: '', node: tail }])
    if (active && !items.length) bot('waiting', [], { streaming: true })
  }
  if (!readRejected) for (const row of localMessages) entries.push({ id: row.id, role: 'person', at: row.at, text: row.text,
    status: row.phase === 'accepted' ? 'sent' : row.phase, deliveryMessage: row.error,
    ...(row.phase === 'failed' && (!replyBlocked || row.review) ? { onRetry: () => { void send(undefined, undefined, row) } } : {}) })
  for (const entry of entries) {
    if (entry.role !== 'person') continue
    const { quote, text } = splitReplyQuote(entry.text)
    if (quote) {
      entry.text = text
      entry.attachments = [{ id: 'reply-quote', name: quote, meta: quoteLabel }]
    }
    const files = splitChatFiles(entry.text)
    entry.body = <AgentCitationsContext value={citations.settled}>
      <span data-thread-item={entry.id.startsWith(`${runId}:`) ? entry.id.slice(runId.length + 1) : undefined}><PersonReferences text={files.text} /></span>
      <ChatFileCards files={files.files} sent />
    </AgentCitationsContext>
    const previous = entry.actions
    entry.actions = <MessageActions className={HOVER_ACTIONS}><CopyAction text={files.text} />{previous}</MessageActions>
  }
  if (!data && collect) entries.push({ id: `${runId}:loading`, role: 'bot', event: true, at: 0, parts: [{ kind: 'text', text: '', node: waiting }] })
  // Re-publish the admitted read itself; identical lengths need not mean the content or permission is unchanged.
  useEffect(() => { if (collect) collect(runId, entries) }, [collect, runId, data, error, active, canRetry, sending, view?.status, retryLabel, delivery.rows, stepsOpen, citations.settled, olderState]) // eslint-disable-line react-hooks/exhaustive-deps
  if (collect) return null
  async function updateQueue(messageId: string, action: 'cancel' | 'sendNow') {
    try {
      const { changeQueuedThreadReply } = await import('@/app/actions/agents')
      const result = await changeQueuedThreadReply({ issueId, runId: liveRunId, messageId, action })
      if (result.error) setSendFailed(actionError(result.error))
      else if (result.status === 'tooLate') setSendFailed(t('deliveryTooLate'))
      await mutate()
    } catch { setSendFailed(feedback('sendUncertain')) }
  }
  const queueControls = <div className="flex flex-col gap-1 px-3">
    {modes.length > 0 && <NativeSelect size="sm" aria-label={t('deliveryMode')} value={selectedMode} onChange={event => {
      const next = modes.find(mode => mode === event.target.value)
      if (next) setDeliveryMode(next)
    }}>{modes.map(mode => <NativeSelectOption key={mode} value={mode}>{t(`deliveryModes.${mode}`)}</NativeSelectOption>)}</NativeSelect>}
    {data?.delivery?.queued.map(row => <div key={row.id} className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
      <span className="min-w-0 flex-1 break-words">{row.text}</span>
      <span>{row.status === 'failed' ? row.failureCode ? actionError(row.failureCode) : t('deliveryFailed') : row.status === 'delivering' ? t('deliverySending') : t('deliveryQueued')}</span>
      {row.status === 'queued' && <>
        {modes.includes('steer') && <Button type="button" size="xs" variant="ghost" onClick={() => void updateQueue(row.id, 'sendNow')}>{t('deliverySendNow')}</Button>}
        <Button type="button" size="xs" variant="ghost" onClick={() => void updateQueue(row.id, 'cancel')}>{t('deliveryCancel')}</Button>
      </>}
    </div>)}
  </div>
  const recorded = data?.composerModel ?? data?.context?.composerModel
  const currentModel = recorded?.served || recorded?.selected
  const pickerEnabled = issueId && data?.live?.viewerId && !active && !question && !replyBlocked && !changeRequest &&
    (detail?.harness === 'codex' || detail?.harness === 'claude_code')
  const currentModelName = currentModel ? modelDisplayName(currentModel).name : null
  const requestedModelName = recorded?.selected ? modelDisplayName(recorded.selected).name : null
  const modelControl = !readOnly && (pickerEnabled && issueId
    ? <BotModelPicker botId={null} thread={{ scope: JSON.stringify([data?.live?.viewerId, issueId, liveRunId]),
      load: () => getThreadContinuationModels(issueId, liveRunId), selected: pickedModel ? threadModelKey(pickedModel) : null, choose: id => setPickedModel(choiceFromMenu(id)) }} />
    : currentModel && <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
      title={requestedModelName && requestedModelName !== currentModelName ? t('composerModelRequested', { model: requestedModelName }) : undefined}>
      <ProviderMark provider={modelProvider(currentModel)} /><span className="truncate">{currentModelName}</span>
    </span>)
  const referenceWorkspace = liveRuns.find(run => run.id === liveRunId)?.workspaceId
  const references = !composerUnavailable && referenceWorkspace && data?.thread.ownedByCurrentUser ? <ThreadReferencePicker draft={draft}
    workspaceId={referenceWorkspace} input={inputRef} onChange={setDraft} /> : null
  const conversation = data || beforeEntries?.length || afterEntries?.length ? <div data-slot="thread-conversation" className="flex min-h-0 flex-1 flex-col"><ThreadScreen host={host} botId={null} name={title} mark={author?.mark ?? null} readOnly={readOnly && !changeRequest} scrollRef={transcript} entries={atTheirTime([...beforeEntries ?? [], ...entries, ...afterEntries ?? [], ...!data ? [{ id: `${runId}:loading`, role: 'bot' as const, event: true as const, at: Date.now(), parts: [{ kind: 'text' as const, text: '', node: waiting }] }] : []], childEntries)}
    panels={bare || transcriptOnly || collect ? undefined : panels}
    historyPrepend={historyPrepend}
    older={olderPosition ? { loading: olderState === 'loading', auto: olderState === 'idle', onLoad: () => { void loadOlder() } } : undefined}
    working={working} onStop={working && canStop ? () => { void stop() } : undefined}
    composer={{ ref: inputRef, leadingControls: <ChatComposerAttachment />, leftControls: modelControl, label: composerUnavailable ? t(data && !isThreadRun(data.thread) ? 'checkEnded' : 'replyUnavailable') : t('composer', { agent: harnessLabel(threadComposerHarness(detail?.harness ?? '', liveRunId, modelFallback)) }), value: draft, onChange: setDraft, onSubmit: () => { void send() },
      attachmentScope: { kind: 'thread', id: liveRunId }, attachmentDisabled: composerUnavailable, sending: sending || stopPending, editableWhileSending: true, submitDisabled: changeRequest ? false : replyBlocked || stopRequested || question === 'resuming',
      running: working || (question === 'resuming' && !data?.thread.questionWake), thread: true }}
    pending={[...changeRequest ? [{ id: 'change-request', name: changeRequest.label, onRemove: changeRequest.onCancel }] : [], ...replyQuote ? [{ id: 'reply-quote', name: replyQuote, meta: quoteLabel, onRemove: () => setReplyQuote(null) }] : []]}
    notices={<>
      {olderState === 'failed' && olderPosition && <InlineLoadError message={readFailedMessage} retryLabel={retryLabel} onRetry={() => { void loadOlder() }} />}
      {queueControls}
      {references}
      {data?.thread.quota?.paused && <ThreadQuotaPausedCard paused={data.thread.quota.paused} onContinued={() => { void mutate(); refreshLists() }} />}
      {sendFailed && <FieldError className="px-3 text-xs">{sendFailed}</FieldError>}
      {stopFailed && <div role="alert" className="flex items-center gap-2 px-3 text-xs"><span className="text-destructive-foreground">{t('stopFailed')}</span><Button variant="ghost" size="sm" className="min-w-22 max-sm:h-11" onClick={() => { void stop() }}>{t('retryStop')}</Button></div>}
    </>}
    questions={[]} onAnswer={async () => ({ status: 'unavailable', error: '' })} running={0} onOpenTask={() => onOpenTask?.()} onOpenInbox={() => navigate({ section: 'suggestions' })} /></div>
    : <div className="min-h-0 flex-1 overflow-y-auto p-4">{waiting}</div>
  const views: ThreadViewAction[] = []
  if (hasChanges && !viewingChanges) views.push({ id: 'changes', label: t('changesTab'), onSelect: () => setTab('changes') })
  if (acceptance && !accepting) views.push({ id: 'acceptance', label: t('acceptanceTab'), onSelect: () => setTab('acceptance') })
  const viewTitle = viewingChanges ? t('changesTab') : accepting ? t('acceptanceTab') : viewingArtifacts ? t('artifactsTab') : undefined
  const back = viewTitle ? () => setTab('chat') : onBack
  // Esc inside the thread is ←; in its composer or another field it only leaves the field (decision 0301). A window opened from it keeps its own Esc.
  // data-own-scroll: the messages scroll inside and the composer stays at the bottom, so a frame whose one scroller
  // holds this panel (the official work area) gives it the scroller's height instead of growing with it.
  return <section ref={rootRef} aria-label={title} data-run-thread="" data-own-scroll="" className="flex h-full min-h-0 flex-col" onKeyDown={bare || !back ? undefined : event => closeOnEscape(event, headingRef.current, back)}>
    {!bare && <ThreadHeader issueId={issueId} runId={runId} title={title} viewTitle={viewTitle} headingRef={headingRef} onBack={back} onClose={onClose}
      onStop={canStop ? () => { void stop() } : null} onOpenTask={onOpenTask} views={views}
      widen={widen ?? undefined} liveRunId={liveRunId}
      place={detail ? <ThreadRunPlace issueId={issueId} runId={runId} status={view?.status ?? data?.thread.status ?? ''} harness={detail.harness} botName={detail.agentName} /> : null}
      acceptanceBadge={acceptance ? <AcceptanceStateBadge task={acceptance} /> : null}
      identity={data?.thread.ownedByCurrentUser ? <ThreadExecutionIdentity runId={liveRunId} /> : null} />}
    {tabbed && data && !readRejected && <ThreadArtifactsReader issueId={issueId} runId={runId} runIds={[runId, ...(data.thread.attempts ?? []).map(attempt => attempt.runId)]}
      conversation={isThreadRun(data.thread)} status={view?.status ?? data.thread.status} onRead={setArtifacts} />}
    {viewingChanges ? (changes.state === 'ready'
      ? <ThreadChangesPane stateKey={`thread:${runId}:changes`} changes={changes.changes} />
      : <p className="p-4 text-sm text-muted-foreground">{t('changesTooLarge')}</p>)
    : accepting && acceptance ? <div className="flex min-h-0 flex-1 flex-col"><FactoryAcceptancePane task={acceptance} onOpenThread={onOpenThread} /></div>
    : viewingArtifacts && artifacts ? <ThreadArtifactsPane groups={artifacts.groups} focusId={artifacts.focusId} mediaTaskId={artifacts.factoryTaskId ?? runId} />
    : conversation}
    {!readOnly && <SelectionQuote root={rootRef} onQuote={text => { setReplyQuote(text); inputRef.current?.focus() }} />}
  </section>
}
