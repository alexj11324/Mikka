'use client'

import { useViewScroll, useViewState } from '@/lib/hooks/view-state'
import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import useSWR, { unstable_serialize, useSWRConfig } from 'swr'
import { AnimatePresence } from 'motion/react'
import { withBasePath } from '@/lib/base-path'
import { checkPageBuildBeforeAction } from '@/lib/app-build'
import { useTranslations } from 'next-intl'
import { coordinatorHistory, retryCoordinatorTurn, stopCoordinatorTurn, welcomeCoordinator, type CoordinatorChat as Chat } from '@/app/actions/coordinator'
import { getBotModelMenu } from '@/app/actions/execution-settings'
import type { BotModelMenu } from '@/lib/bot-model-menu-view'
import { metadataEntities } from '@/lib/coordinator/chat-poll'
import { readCachedCoordinatorChat } from '@/lib/coordinator/chat-read-client'
import { CacheReadError } from '@/lib/cache-read-error'
import { chatKeys } from '@/lib/swr/keys'
import type { BotView } from '@/app/actions/bots'
import { BotAvatar, COORDINATOR_AVATAR } from '@/components/nav/bot-avatar'
import { cn } from '@/lib/utils'
import { useActionError } from '@/lib/use-action-error'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Message, MessageContent, MessageFooter } from '@/components/ui/message'
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport, useMessageScroller } from '@/components/ui/message-scroller'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { CircleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { AgentCitationsContext, CitationSources, useLinkPreviews, type AgentCitations } from '@/components/workspace/agent-citations'
import { UserMessageText } from '@/components/workspace/user-message-text'
import { CollapsibleMessage } from '@/components/chat/collapsible-message'
import { AgentInteractionContext } from '@/components/workspace/agent-interaction'
import { ReplyAnswer } from '@/components/workspace/agent-decision'
import { AgentThemeProvider } from '@/components/workspace/agent-theme'
import { navigate, openTask, openThread } from '@/components/workspace/workspace-navigation'
import { CoordinatorReply } from './coordinator-reply'
import { ChatComposer } from './chat-composer'
import { BotModelPicker, botModelMenuKey, openModelPicker } from './bot-model-picker'
import { useCoordinatorSubmit } from './use-coordinator-submit'
import { useCoordinatorStream } from './use-coordinator-stream'
import { useLiveKey, useLiveKeys, useLiveScope, watchPageVisibility } from '@/hooks/use-live-key'
import { ListReadScopeError, listReadDeadline, ownerListWorkspace, UNRESOLVED_LIST_SCOPE } from '@/lib/live/list-read'
import { heldRevision } from '@/lib/live/revisions'
import { useLiveCitations } from './use-live-citations'
import type { CoordinatorLiveReply } from '@/lib/coordinator-stream-client'
import { ThreadCard } from './thread-card'
import { firstThreadCards, staleEventPositions, visibleDivider } from '@/lib/coordinator/chat-dedupe'
import { ActivityExpansionContext, ReplyActivity, useActivityExpansion, useThreadToolRows } from './reply-activity'
import { CHAT_SURFACE, ChatMessage, ChatWaiting } from '@ui-slot/chat-message'
import * as threadSlot from '@ui-slot/thread'
import { useConversationPanels, useWorkTabs } from '@/components/coordinator/conversation-panels'
import type { ThreadEntry, ThreadEntryPart } from '@/components/slots/thread-contract'
import { useFactoryQuestions } from '@/hooks/use-factory-questions'
import { noteChipText } from '@/lib/browser/note'
import { PERSON_BUBBLE } from '@/components/slots/chat-message'
import type { ChatSpeaker } from '@/components/slots/chat-message-contract'
import { replySegments, type ReplySegment } from '@/lib/coordinator/reply-segments'
import { runThreadName } from '@/lib/coordinator/citations'
import { MessageReactions, useMessageReactions } from '@/components/workspace/message-reactions'
import { PendingActions } from './pending-actions'
import { SubagentLoginNeeds } from './subagent-login-needs'
import { UnreadDivider } from '@/components/chat/unread-divider'
import { UnreadPill } from '@/components/chat/unread-pill'
import { MESSAGE_POSITION_ATTR, useUnreadIndicators } from '@/lib/hooks/use-unread-indicators'
import { useArrivals } from '@/lib/hooks/use-arrivals'
import { openArtifact as openArtifactWindow } from '@/components/workspace/workspace-navigation'
import { ArtifactChip } from '@/components/artifacts/artifact-card'
import { ArtifactReviewCard } from '@/components/workspace/artifact-review'
import { ArtifactQuoteChip, ArtifactQuoteLine, QuoteChip, QuoteLine } from '@/components/artifacts/artifact-quote'
import { MessageActions } from '@/components/ai-elements/message'
import { CopyAction, REPLY_ACTIONS } from '@/components/chat/copy-action'
import { SelectionQuote } from '@/components/chat/selection-quote'
import { splitReplyQuote, withReplyQuote } from '@/lib/chat-quote'
import { replyCopyText } from '@/lib/chat-copy'
import type { ArtifactChatSlot } from '@/components/artifacts/artifact-viewer'
import { BrowserNoteChip, BrowserNoteLine, useBrowserNotesComposer } from '@/components/browser/browser-notes'
import { SentSuggestion } from '@/components/suggestions/mobile-card'
import { HostedRefusalNotice } from '@/components/billing/hosted-refusal-notice'
import { hostedRefusal } from '@/lib/billing/verification-client'
import { subscriptionRefusal } from '@/lib/subscription-refusal'
import { chatBalanceRefusal } from '@/lib/chat-balance'
import { chatFailure } from '@/lib/chat-failure'
import { SubscriptionRefusalNotice } from './subscription-refusal-notice'
import { HostedUnavailableNotice } from './hosted-unavailable-notice'
import { CloudFailureAction, FailureReason } from './failure-reason'
import { RunErrorDetails } from '@/components/workspace/run-error-text'
import { QuotaNotice, QuotaSwitchLine } from './quota-notice'
import { ChatEventLine } from './chat-event-line'
import { RetryReplyButton } from './retry-reply-button'
import { COMPOSER_NOTICE } from './composer-notice'
import { FieldError } from '@/components/ui/field'

/** A new message's enter: a short fade (docs/design/decisions/2026-10-31-1814-segmented-control-motion.md). */
const ENTER = 'animate-in fade-in-0 duration-200 motion-reduce:animate-none'

/**
 * The band under the header pill (top 12px, 36px tall): nothing shows down to 56px, 8px below the pill, then rows fade
 * in over 40px by 96px, where the first message starts (`pt-24`). A shorter ramp left a chart under the pill reading as a
 * gradient fill. It replaces the scroller's own mask and keeps its bottom fade. Wide screens only;
 * phones have no pill.
 */
const HEADER_FADE = 'md:[--scroll-fade-mask:linear-gradient(to_bottom,transparent_3.5rem,#000_6rem,#000_calc(100%_-_var(--scroll-fade-b,0px)),transparent)]'


/** Text put into the composer from elsewhere; `suggestionId` when it came from a 建议 item. */
export type CoordinatorPrefill = { text: string; nonce: number; suggestionId?: string }

/** A chat read and when it was asked for, which anchors its live deadline (lib/live/list-read.ts). */
type ChatRead = Chat & { requestedAt?: number }
/** Pushes closer together than this share one read; the stream shows a turn's words meanwhile. */
const CHAT_MERGE_MS = 2_000

/** The SWR key of a chat: the Coordinator's, or one bot's. */
/** A passing usage limit (another turn running, a cost read): the next send works without anything changing. */
const TRANSIENT_REFUSALS: ReadonlySet<string> = new Set(['usage_in_progress', 'usage_concurrency_limit', 'usage_cost_unavailable'])

export const coordinatorChatKey = chatKeys.detail

/** A reply still streaming, drawn by the same row as a stored one; after 停止 it reads 已停止 before the server has stored it. */
function streamedItem(reply: CoordinatorLiveReply, stopping = false): Chat['items'][number] {
  return { position: -1, from: 'coordinator', text: reply.text, tools: [], threads: [], artifacts: [], createdAt: '',
    ...(stopping && reply.committedThrough === undefined ? { stopped: true } : {}),
    ...(reply.tools?.length || reply.thinking ? { activity: { tools: reply.tools ?? [], thought: Boolean(reply.thinking) } } : {}) }
}

/** A reply's rows top to bottom (lib/coordinator/reply-segments.ts); its thinking, when it thought, leads them. */
function replyRows(item: Chat['items'][number], live: CoordinatorLiveReply | undefined): ReplySegment[] {
  const rows = replySegments(item.text, item.activity?.tools ?? [])
  return (item.activity?.thought || live?.thinking) && rows[0]?.kind !== 'tools' ? [{ kind: 'tools', tools: [] }, ...rows] : rows
}

/** A live reply's thinking as the activity shows it: still thinking, or the whole seconds it took (at least one). */
function liveThinking(reply: CoordinatorLiveReply) {
  return reply.thinking && { active: reply.thinking.since !== undefined, seconds: Math.max(1, Math.round(reply.thinking.ms / 1000)), ...(reply.thinking.text ? { text: reply.thinking.text } : {}) }
}

/** A sent message's words, under the reply words it quotes (lib/chat-quote.ts) and anything else it carries. */
function PersonWords({ text, before }: { text: string; before?: ReactNode }) {
  const { quote, text: words } = splitReplyQuote(text)
  return <CollapsibleMessage>{quote && <QuoteLine slot="reply-quote" text={quote} />}{before}<UserMessageText text={words} /></CollapsibleMessage>
}

/** Only an accepted send from this composer brings the chat back to its end. Background catch-up keeps the reading position. */
function FollowSentMessages({ count }: { count: number | null }) {
  const { scrollToEnd } = useMessageScroller()
  const seen = useRef(count)
  useEffect(() => {
    if (count === null) return
    if (seen.current !== null && count > seen.current) scrollToEnd()
    seen.current = count
  }, [count, scrollToEnd])
  return null
}

/**
 * The person's conversation with their Coordinator, which dispatches agents to
 * issues, or with one of their bots: a bot runs on the same harness with its
 * own conversation, memory and name. Artifacts agents hand over show as cards
 * under a reply and open the reader; inside the reader the same chat runs
 * `embedded`, with chips instead of cards and the quote from the artifact in
 * the composer.
 */
/** A thread card or chip opens the thread in the right column; the chat stays (R-66, R-82). */
const showThread = ({ runId }: { runId: string }) => openThread(runId)

/** Starting goals offered in an empty Coordinator chat (coordinator's choice, 2026-11-08). */
const STARTERS = ['fixBug', 'reviewPullRequests', 'summarizeToday', 'dailyBriefing'] as const

export function CoordinatorChat({ onOpenIssue, prefill, placeholder, compact = false, embedded, bot, userId }: { onOpenIssue: (id: string) => void; prefill?: CoordinatorPrefill; placeholder?: string; compact?: boolean; embedded?: ArtifactChatSlot; bot?: BotView; userId?: string }) {
  const t = useTranslations('Coordinator')
  const cloudErrors = useTranslations('RunErrors')
  const tNav = useTranslations('Nav')
  const tCommon = useTranslations('Common')
  const botId = bot?.id ?? null
  const name = bot?.name ?? t('label')
  const avatar = (size: 'pill' | 'profile', mood?: 'thinking') => <BotAvatar {...(bot ? { id: bot.id, color: bot.color, shape: bot.shape } : COORDINATOR_AVATAR)} size={size} mood={mood} />
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const actionError = useActionError()
  const { cache, mutate: mutateAll } = useSWRConfig()
  const selectedWorkspaceId = useLiveScope()?.workspaceId
  const reconnectStream = useRef<() => void>(() => {})
  // A read names the version it shows; an unchanged chat comes back as its live state only (lib/coordinator/chat-poll.ts).
  const shown = useRef<{ chat?: ChatRead; metadataStale: boolean; fullReadAt: number }>({ metadataStale: false, fullReadAt: -Infinity })
  const chatKey = coordinatorChatKey(botId)
  const { data: cachedData, mutate, error: loadError } = useSWR<ChatRead>(chatKey, async () => {
    const refreshMetadata = shown.current.metadataStale
    shown.current.metadataStale = false
    if (refreshMetadata || !shown.current.chat) shown.current.fullReadAt = performance.now()
    try { return await readCachedCoordinatorChat(cache, botId, { refreshMetadata }) }
    catch (error) { if (refreshMetadata) shown.current.metadataStale = true; throw error }
  }, {
    onSuccess: () => reconnectStream.current(),
  })
  const unavailable = loadError instanceof CacheReadError || loadError instanceof ListReadScopeError
  const data = unavailable ? undefined : cachedData
  useEffect(() => { shown.current.chat = data }, [data])
  // No timer reads this chat (#1212). A committed message, inbox event, turn change or run change in it pushes
  // its key on the owner's home channel; a turn's lease running out has no write, so its expiry is a deadline.
  // While the channel is down the live layer falls back to one read a minute. The stream still carries a turn.
  const liveOwner = data?.live?.ownerId
  const liveHome = liveOwner ? ownerListWorkspace(data, liveOwner) : null
  // A push this chat already read (a duplicate, or the echo of this tab's own send) is skipped.
  useLiveKey('bot_chat', unavailable ? null : liveHome && data?.botId ? data.botId : UNRESOLVED_LIST_SCOPE, [unstable_serialize(chatKey)], liveHome,
    { minIntervalMs: CHAT_MERGE_MS, deadline: liveOwner ? listReadDeadline(data, liveOwner) : undefined, revisions: { [unstable_serialize(chatKey)]: heldRevision(data, 'bot_chat', data?.botId) }, shareAcrossTabs: true })
  // Cards and cited names have no chat write (lib/coordinator/chat-poll.ts). An
  // artifact push or visibility catch-up refreshes metadata using the same cursor.
  const metadataKey = useMemo(() => chatKeys.metadata(botId), [botId])
  useSWR(data ? metadataKey : null, async () => {
    // Catching up, the chat's own read already refreshed metadata.
    if (shown.current.metadataStale || performance.now() - shown.current.fullReadAt < 1_000) return true
    shown.current.metadataStale = true; await mutate(); return true
  }, {
    revalidateOnMount: false, revalidateIfStale: false, revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false,
  })
  const artifactsShown = data?.artifacts
  const metadata = useMemo(() => metadataEntities({ artifacts: artifactsShown }), [artifactsShown])
  useLiveKeys(liveHome ? metadata : [], [unstable_serialize(metadataKey)], liveHome, { minIntervalMs: CHAT_MERGE_MS })
  // Deleting a cited task or changing workspace access need not write a chat
  // message. Reuse the existing list push; the next cursor read reauthorizes
  // decorations and removes anything it can no longer return.
  const hasSources = Boolean(Object.keys(data?.sources ?? {}).length)
  const sourceScopes = [...new Set([liveHome, selectedWorkspaceId].filter((scope): scope is string => Boolean(scope)))]
  useLiveKeys(hasSources ? sourceScopes.map(workspaceId => ({ kind: 'issue_list' as const, id: workspaceId, workspaceId })) : [], [unstable_serialize(metadataKey)], null, { minIntervalMs: CHAT_MERGE_MS })
  useEffect(() => watchPageVisibility(() => { if (document.visibilityState === 'hidden' && shown.current.chat) shown.current.metadataStale = true }), [])
  const [loadingHistory, setLoadingHistory] = useState(false)
  async function loadHistory() {
    if (!data?.historyBefore || loadingHistory) return
    setLoadingHistory(true)
    try {
      const persisted = data.items.filter(item => !item.pending)
      const through = persisted[1] ? persisted[1].position - 1 : data.historyBefore - 1
      const page = await coordinatorHistory(botId, through)
      await mutate(current => current ? { ...current, items: [...page.items, ...current.items.filter(item => item.pending || item.position > through)], sources: { ...current.sources, ...page.sources }, artifacts: { ...current.artifacts, ...page.artifacts }, historyBefore: page.historyBefore } : current, { revalidate: false })
    } catch { toast.error(actionError()) } finally { setLoadingHistory(false) }
  }
  // A sent message waits in the inbox for its turn: the stream opens now, so the first words show as they come.
  const stream = useCoordinatorStream({ botId, runId: data?.streamRunId, waiting: Boolean(data?.working && !data.streamRunId), cursor: data?.cursor, persistedStreamIds: data?.persistedStreamIds, revalidate: mutate })
  useEffect(() => { reconnectStream.current = stream.reconnect }, [stream.reconnect])
  const stateKey = `bot-chat:${botId ?? 'coordinator'}:${embedded?.activeArtifactId ?? 'main'}`
  const [localSend, setLocalSend] = useState({ key: stateKey, count: 0 })
  const [draft, setDraft] = useViewState(`${stateKey}:draft`, '')
  const updateDraft = setDraft
  // Carry existing window drafts into the new account/workspace-scoped store once.
  useEffect(() => {
    if (!userId || embedded) return
    const legacyKey = `mikka:draft:${userId}:${botId ?? 'coordinator'}`
    try {
      const legacy = window.sessionStorage.getItem(legacyKey)
      if (legacy) { setDraft(current => current || legacy); window.sessionStorage.removeItem(legacyKey) }
    } catch { /* storage unavailable */ }
  }, [userId, botId, embedded, setDraft])
  const [following, setFollowing] = useViewState(`${stateKey}:following`, true)
  // Hydration first exposes server defaults; lock the initial scroll choice only
  // after the saved session and the transcript have both been read.
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  const initialScroll = useRef<{ key: string; following: boolean | null }>({ key: stateKey, following: null })
  if (initialScroll.current.key !== stateKey) initialScroll.current = { key: stateKey, following: null }
  if (mounted && data && initialScroll.current.following === null) initialScroll.current.following = following
  const startAtEnd = initialScroll.current.following ?? following
  const transcript = useViewScroll<HTMLDivElement>(`${stateKey}:messages`, !!data, !startAtEnd)
  const [sending, setSending] = useState(false)
  // Words picked from a reply with 引用: they wait above the draft and head the next message as quote lines.
  const [replyQuote, setReplyQuote] = useViewState<string | null>(`${stateKey}:quote`, null)
  function quoteReply(text: string) {
    setReplyQuote(text)
    inputRef.current?.focus()
  }
  const deliveryInFlight = useRef(false)
  // A message that did not go stays in the chat as a failed bubble with 重试, as in iMessage and Slack. Retrying here
  // resends the same submission (same id), so it is stored once.
  // `after`: the last stored position when it failed.
  // `retryOf`: the stored failed message this send retries in place (重新发送); it stays hidden from then on.
  const [failed, setFailed] = useState<{ text: string; withNotes: boolean; message: string; after: number; retryOf?: number } | null>(null)
  const [retrying, setRetrying] = useState<ReadonlySet<number>>(() => new Set())
  const { submit, failureMessage } = useCoordinatorSubmit()
  // Notes pinned in the browser wait in this composer while it is the chat on screen (not inside the reader).
  const browser = useBrowserNotesComposer(!embedded)
  const noteCount = browser?.notes.length ?? 0
  useEffect(() => { if (noteCount) inputRef.current?.focus() }, [noteCount])
  // The 建议 item whose text is in the composer: once sent, the Coordinator dispatches a thread for it and it leaves 建议.
  const suggestion = useRef<string | null>(null)
  // 「让 Agent 安排」 and 建议 items put their sentence here for the person to finish (MIK-39).
  useEffect(() => {
    if (!prefill) return
    suggestion.current = prefill.suggestionId ?? null
    setDraft(prefill.text)
    const input = inputRef.current
    if (input) { input.focus(); input.setSelectionRange(prefill.text.length, prefill.text.length) }
  }, [prefill])
  // A failed message sent again is retried in place: it goes at once, and the server leaves it out from then on.
  // A failed welcome stands only until a reply follows (an incremental read appends the reply after it).
  const items = useMemo(() => (data?.items ?? []).filter((item, index, all) => !(item.from === 'person' && retrying.has(item.position))
    && !(item.welcome && all.slice(index + 1).some(next => next.from === 'coordinator'))), [data, retrying])
  // One thread has one card in a chat (R-66): under the first reply that dispatched it; later replies name it in their words.
  const firstThreadCard = useMemo(() => firstThreadCards(items), [items])
  // A thread's event line said again later (「… 在等你回答」 twice) shows only the latest one (R-66).
  const staleEvents = useMemo(() => staleEventPositions(items), [items])
  /** The thread cards under `item`: those whose first reply it is; a live reply only threads no stored reply has carded. */
  const cardsOf = (item: Chat['items'][number], live: boolean) => item.threads.filter(id => (live ? !firstThreadCard.has(id) : firstThreadCard.get(id) === item.position) && sources?.[id]?.kind === 'run')
  // A send whose result was unknown may have been stored after all: once it shows up in the chat, the failed bubble goes.
  useEffect(() => {
    if (failed && items.some(item => item.from === 'person' && item.position > failed.after && item.text === failed.text)) setFailed(null)
  }, [failed, items])
  // New messages fade in briefly, as in Claude Code; what was there when the chat opened does not (R-37).
  // A stored reply that replaces a reply already streamed on screen is not new.
  const streamedThrough = useRef(-1)
  useEffect(() => { for (const reply of stream.replies) if (reply.committedThrough !== undefined) streamedThrough.current = Math.max(streamedThrough.current, reply.committedThrough) })
  const arriving = useArrivals(data ? [...items.map(item => `item-${item.position}`), ...stream.replies.map(reply => `stream-${reply.id}`)] : null)
  // The working line fades in when a turn starts after the chat opened, not when the chat opens mid-run.
  const loaded = useRef(false)
  const workingAtOpen = useRef(false)
  useEffect(() => {
    if (!data) return
    if (!loaded.current) { loaded.current = true; workingAtOpen.current = Boolean(data.working) }
    else if (!data.working) workingAtOpen.current = false
  })
  const workingEnter = loaded.current && !workingAtOpen.current
  const entering = (item: (typeof items)[number]) => arriving(`item-${item.position}`) && !(item.from === 'coordinator' && item.position <= streamedThrough.current)
  // A turn the hosted model (Mikka 默认) refused: verification, allowance or pause (#523, #525, #526).
  const refusal = data?.working ? null : hostedRefusal(data?.error)
  // The chosen subscription refused it: the mapped line, never the raw step error.
  const declined = data?.working || refusal ? null : subscriptionRefusal(data?.error)
  const apiBalance = !data?.working && !refusal && !declined && chatBalanceRefusal(data?.error)
  // 重试 on any failed reply, never on a wake still being retried by the server.
  const retry = <RetryReplyButton botId={botId} onQueued={mutate} />
  const liveFailure = data?.error && !data.working ? chatFailure({ working: false, error: data.error, cause: data.cause }) : null
  const cloudCode = liveFailure?.kind === 'failed' ? liveFailure.cloudCode : undefined
  const liveRaw = liveFailure?.raw ?? null
  const wakeError = data?.error === 'wake_failed' || data?.error === 'wake_start_unconfirmed' || data?.error === 'wake_exhausted' ? data.error : null
  // With no Coordinator here, the person's last message gets no reply: show it as a failed turn instead of silence.
  // A failed turn's own line already says why; this one is only for a chat with no Coordinator to answer.
  const unanswered = data?.enabled === false && !data.error && items.findLast(item => item.from !== 'event')?.from === 'person'
  // The failure of the newest turn sits under the message it was answering (it carries the mark, store.failTurn),
  // with its way on; an older failure keeps only its reason there. Without the mark it stays above the composer.
  const lastSaid = items.findLast(item => item.from !== 'event')
  const failedAt = data?.error && !data.working && (lastSaid?.from === 'person' || lastSaid?.welcome) && lastSaid.failure ? lastSaid.position : null
  // The welcome never came: its failure is the chat's one line, on the Bot's side, never only a banner (11 people on 11-02).
  const welcomeFailed = Boolean(data?.error && !data.working && (lastSaid?.welcome || (!items.length && !stream.replies.length)))
  // No empty chats: the Coordinator, like every bot, writes its welcome first.
  const welcomed = useRef(false)
  // A welcome Mikka 默认 refused runs again once its model becomes runnable while this chat is open (the trial points
  // arrived, a card was verified): only on a change from not runnable to runnable seen by this mount, never on open
  // (the menu can read runnable while the server still refuses), never for a passing usage limit, never in a hidden
  // tab, and once per failure (store.retryFailedTurn), so a visit never fires another refused turn.
  const welcomeModel = useSWR<BotModelMenu>(welcomeFailed && refusal ? botModelMenuKey(botId ?? null) : null, () => getBotModelMenu(botId ?? null))
  const runnable = welcomeModel.data?.current?.available
  const wasRunnable = useRef<boolean | undefined>(undefined)
  const rewelcomed = useRef<string | null>(null)
  useEffect(() => {
    if (!data?.enabled || data.working || welcomed.current) return
    if (data.error) {
      if (document.visibilityState !== 'visible') return
      const was = wasRunnable.current
      if (runnable !== undefined) wasRunnable.current = runnable
      if (!welcomeFailed || !refusal || TRANSIENT_REFUSALS.has(refusal) || was !== false || runnable !== true || rewelcomed.current === data.error) return
      rewelcomed.current = data.error
      void (botId ? retryCoordinatorTurn(botId) : retryCoordinatorTurn()).then(() => mutate())
      return
    }
    if (items.length) return
    welcomed.current = true
    void (botId ? welcomeCoordinator(botId) : welcomeCoordinator()).then(() => mutate())
  })
  // The raw step error (workflow ids, retries, socket codes) is for the logs, never the chat: 回复失败 and 重试 (review C4).
  const failureNotice = <>
    {cloudCode && <Alert variant="destructive" className={COMPOSER_NOTICE}><AlertTitle className="min-w-0 flex-1 basis-48" data-chat-failure="cloud">{cloudErrors(`${cloudCode}.default`)}</AlertTitle><span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1"><CloudFailureAction code={cloudCode} fallback={retry} /></span></Alert>}
    {refusal && <HostedRefusalNotice code={refusal} botId={botId} retry={retry} onQueued={mutate} />}
    {declined && declined !== 'quotaUsed' && <SubscriptionRefusalNotice notice={declined} retry={retry} botId={botId} />}
    {apiBalance && <Alert variant="destructive" className={COMPOSER_NOTICE}><AlertTitle className="min-w-0 flex-1 basis-48" data-chat-failure="balance">{t('apiBalance')}</AlertTitle><span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1"><Button size="sm" onClick={() => openModelPicker(botId)}>{t('modelPicker.changeModel')}</Button></span></Alert>}
    {data?.error && !data.working && !cloudCode && !refusal && !declined && !apiBalance && <Alert variant="destructive" className={COMPOSER_NOTICE}>{wakeError ? <AlertTitle>{t(`wakeErrors.${wakeError}`)}</AlertTitle> : <><AlertTitle className="min-w-0 flex-1 basis-48" data-chat-failure="failed">{t('failedTitle')}</AlertTitle><span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">{retry}</span></>}</Alert>}
    {/* The stored codes, and the turn failure behind a wake code, only under 详情 (decision 2026-11-05-0330). */}
    {liveRaw && <RunErrorDetails code={liveRaw} />}
  </>
  // The newest reply keeps its actions in view, as Claude's does; older ones show them on hover.
  const lastReplyAt = stream.replies.length ? -1 : items.findLast(item => item.from === 'coordinator' && item.text)?.position
  const rootRef = useRef<HTMLElement>(null)
  // Events are system lines, not messages; the person's own messages never count as unread.
  // A failed welcome is the Bot saying nothing yet: never an unread message.
  const unreadItems = useMemo(() => items.filter(item => item.from !== 'event' && !item.welcome).map(item => ({ position: item.position, messageId: item.id ?? String(item.position), own: item.from === 'person', reportable: !item.pending })), [items])
  // Reactions people gave on the phone (decision 2026-11-01-0030-mobile-reactions); a pending row has none yet.
  const reactions = useMessageReactions(items.map(item => item.pending || item.from === 'event' ? null : item.id))
  const unread = useUnreadIndicators({ conversationId: botId ? `bot:${botId}` : 'coordinator', items: unreadItems, rootRef })
  // The divider stays when the row it marked is a hidden repeat: it moves to the next row shown.
  const dividerAt = visibleDivider(unread.divider, items, staleEvents)
  const previews = useLinkPreviews(items.filter(item => item.from === 'coordinator').map(item => item.text))
  const sources = data?.sources
  // A layer that draws the conversation as one screen (slot `thread`) gets the same rows as data and nodes.
  // The board's chat column (compact) is a conversation too; only an artifact's chat (embedded) keeps its chips.
  const Screen = !embedded ? threadSlot.ThreadScreen ?? null : null
  // The Overview and the browser, when the frame's work area holds them (FRAME_OWNS_PANEL).
  const panels = useConversationPanels()
  // Tasks and threads opened from this chat open as tabs of that work area (decision 2026-11-10), named by their code.
  const work = useWorkTabs(Boolean(Screen && panels && !compact), {
    task: id => {
      const source = Object.values(sources ?? {}).find(item => item.kind === 'issue' ? item.id === id : item.issue?.id === id)
      const issue = source?.kind === 'issue' ? source : source?.issue
      return issue?.identifier ?? issue?.title ?? t('citation.issue')
    },
    thread: id => {
      const run = sources?.[id]
      if (run?.kind !== 'run') return { title: t('citation.run') }
      return { title: run.issue?.identifier ? `${run.issue.identifier} › ${run.name || runThreadName(run)}` : runThreadName(run), issueId: run.issue?.id ?? null, name: runThreadName(run) }
    },
  }, name)
  const openIssue = work.work ? work.openTask : onOpenIssue
  const citations = useMemo<AgentCitations>(() => ({ sources: sources ?? {}, previews, onOpenIssue: openIssue }), [sources, previews, openIssue])
  // A live reply cites tasks and threads the stored chat may not know yet; they are looked up as it streams.
  const liveCitations = useLiveCitations(stream.replies.map(reply => reply.text), citations)
  // What the person said next after each reply, so a choice card shows its answer after a reload.
  const answers = useMemo(() => {
    const next = new Map<number, string>()
    let said: string | null = null
    for (const item of [...items].reverse()) {
      if (item.from === 'person') said = item.text
      else if (item.from === 'coordinator' && said !== null) next.set(item.position, said)
    }
    return next
  }, [items])
  // An artifact handed over shows here first; the Artifact page and a thread's 「Artifact · N」 refresh with it.
  const artifactIds = useMemo(() => items.flatMap(item => item.artifacts).join(','), [items])
  useEffect(() => {
    if (!artifactIds) return
    void mutateAll(key => key === 'artifacts' || (Array.isArray(key) && key[0] === 'run-artifacts'))
  }, [artifactIds, mutateAll])
  // Not inside a reader: the card opens the Artifact window over the page, with its own address (R-82).
  const openArtifact = embedded?.openArtifact ?? openArtifactWindow
  // A quote just picked in the reader: put the cursor where the request goes.
  useEffect(() => { if (embedded?.quote) inputRef.current?.focus() }, [embedded?.quote])

  // 停止 shows at once, as Esc does in Claude Code and Codex: the reply in flight reads 已停止 and the composer is free
  // again while the turn ends on the server, keeping what it had said.
  const [stopping, setStopping] = useState(false)
  const working = Boolean(data?.working)
  useEffect(() => { if (!working) setStopping(false) }, [working])
  async function stop() {
    setStopping(true)
    try {
      const result = await stopCoordinatorTurn(botId)
      if (result.error) { setStopping(false); toast.error(actionError(result.error)) }
      await mutate()
    } catch { setStopping(false); toast.error(actionError()) }
  }

  /** Sends `text` to the Coordinator or bot, with the browser's notes when `withNotes`: sent, failed (now a failed bubble), or skipped. */
  async function deliver(text: string, withNotes = false, retryOf?: number): Promise<'sent' | 'failed' | 'skipped'> {
    if (!text || sending || deliveryInFlight.current) return 'skipped'
    deliveryInFlight.current = true
    const notes = withNotes && browser?.notes.length ? [...browser.notes] : undefined
    const fail = (message: string | null) => {
      if (!message) return 'skipped' as const
      // Offline, the message never left: say that, not a generic failure (usability review N3). 重试 stays beside it.
      if (typeof navigator !== 'undefined' && navigator.onLine === false) message = t('sendOffline')
      setFailed({ text, withNotes, message, after: items.at(-1)?.position ?? 0, ...(retryOf !== undefined ? { retryOf } : {}) })
      return 'failed' as const
    }
    try {
      if (!await checkPageBuildBeforeAction()) return 'skipped'
      setSending(true)
      if (retryOf !== undefined) setRetrying(current => new Set(current).add(retryOf))
      const outcome = await submit(text, { quote: embedded?.quote, botId, notes, ...(retryOf !== undefined ? { retryOf } : {}) })
      if (outcome.kind !== 'accepted') return fail(failureMessage(outcome))
      setFailed(current => current?.text === text ? null : current)
      embedded?.clearQuote()
      if (notes) browser?.removeMany(notes.map(note => note.n))
      await mutate()
      setLocalSend(current => ({ key: stateKey, count: current.key === stateKey ? current.count + 1 : 1 }))
      return 'sent'
    } catch { return fail(actionError()) } finally { deliveryInFlight.current = false; setSending(false) }
  }
  /** Sends `text`; false if it did not go. */
  async function post(text: string, withNotes = false) {
    return await deliver(text, withNotes) === 'sent'
  }
  async function send(event?: FormEvent) {
    event?.preventDefault()
    const text = draft.trim()
    const result = text ? await deliver(withReplyQuote(text, replyQuote), true) : 'skipped'
    if (result === 'skipped' || result === 'failed') return
    setReplyQuote(null)
    setDraft(current => current.trim() === text ? '' : current)
    const id = suggestion.current
    suggestion.current = null
    if (id) {
      await fetch(withBasePath(`/api/suggestions/${id}`), { method: 'DELETE', credentials: 'same-origin' }).catch(() => undefined)
      void mutateAll(key => typeof key === 'string' && key.includes('/api/suggestions'))
      void mutateAll(key => key === 'threads' || Array.isArray(key) && key[0] === 'threads')
    }
  }

  // 全部展开 / 全部收起 for the chat's tool groups (R-83).
  const expansion = useActivityExpansion()

  const speaker: ChatSpeaker = bot ? { id: bot.id, name: bot.name, color: bot.color, shape: bot.shape } : { name, coordinator: true }

  const toolRows = useThreadToolRows()
  const tMessage = useTranslations('AiElements.message')
  const tNavAll = useTranslations()
  // The Coordinator's chat docks the person's pending Factory questions; a read follows the chat's own version.
  const factory = useFactoryQuestions(data?.version ?? data?.cursor ?? null, Boolean(Screen && !botId && data))
  if (Screen) {
    const rows = [...items.filter(item => !staleEvents.has(item.position)).map(item => ({ item, live: undefined as CoordinatorLiveReply | undefined, key: String(item.pending ? `pending-${item.position}` : item.streamId ?? item.position) })),
      ...stream.replies.map(reply => ({ item: streamedItem(reply, stopping), live: stopping && reply.committedThrough === undefined ? { ...reply, committedThrough: -1 } : reply, key: reply.id }))]
    const entries: ThreadEntry[] = []
    for (const { item, live, key } of rows) {
      const at = item.createdAt ? Date.parse(item.createdAt) : Date.now()
      const streaming = Boolean(live && live.committedThrough === undefined)
      if (item.from === 'event') {
        const node = item.notice ? <QuotaSwitchLine notice={item.notice} botId={botId} /> : item.line ? <ChatEventLine line={item.line} citations={citations} /> : null
        if (node) entries.push({ id: key, role: 'bot', at, parts: [{ kind: 'text', text: '', node }] })
        continue
      }
      if (item.from === 'person') {
        const { quote, text } = splitReplyQuote(item.text)
        const attachments = [
          ...(item.suggestion ? [{ id: 'suggestion', name: item.suggestion.actionTitle ?? item.suggestion.title, meta: tNavAll('Nav.suggestions') }] : []),
          ...(item.quote ? [{ id: 'artifact-quote', name: data?.artifacts[item.quote.artifactId]?.title ?? item.quote.label ?? item.quote.text, meta: tMessage('quote') }] : []),
          ...(quote ? [{ id: 'reply-quote', name: quote, meta: tMessage('quote') }] : []),
          ...(item.notes ?? []).map(note => ({ id: `note-${note.n}`, name: noteChipText(note), meta: tNavAll('Editor.richText.annotate') })),
        ]
        entries.push({ id: key, role: 'person', at, text, ...(attachments.length ? { attachments } : {}), status: item.pending ? 'sending' : 'sent',
          actions: item.text ? <MessageActions className={cn('items-start', REPLY_ACTIONS)}><CopyAction text={text} />{item.id && <MessageReactions reactions={reactions[item.id]} align="end" />}</MessageActions> : undefined })
        if (item.failure) entries.push({ id: `${key}-failure`, role: 'bot', at, parts: [{ kind: 'error', text: t('failedTitle'), actions: item.position === failedAt
          ? failureNotice
          : <FailureReason retry={item.welcome} failure={item.failure} botId={botId} sending={sending} onResend={() => { if (item.welcome) void (botId ? retryCoordinatorTurn(botId) : retryCoordinatorTurn()).then(() => mutate()); else void deliver(item.text, false, item.position) }} /> }] })
        continue
      }
      const parts: ThreadEntryPart[] = item.welcome ? [] : replyRows(item, live).map((segment, index): ThreadEntryPart => segment.kind === 'tools'
        ? { kind: 'tools', id: `${key}-tools-${index}`, tools: toolRows(segment.tools, { live: streaming, ...(index === 0 && item.activity ? { thinking: live ? liveThinking(live) : undefined, thought: item.activity.thought } : {}) }) }
        : { kind: 'text', text: segment.text, node: <ReplyAnswer value={live ? null : answers.get(item.position) ?? null}><CoordinatorReply text={segment.text} carded={cardsOf(item, Boolean(live)).join(',')} citations={live ? streaming ? liveCitations.streaming : liveCitations.settled : citations} isStreaming={streaming} /></ReplyAnswer> })
      for (const id of cardsOf(item, Boolean(live))) {
        const run = sources?.[id]
        if (run?.kind === 'run') parts.push({ kind: 'task', run, onOpen: () => run.issue ? openTask(run.issue.id) : showThread({ runId: run.id }) })
      }
      const artifacts = item.artifacts.flatMap(id => data?.artifacts[id] ? [{ id, name: data.artifacts[id].title }] : [])
      if (artifacts.length) parts.push({ kind: 'artifacts', items: artifacts, onOpen: openArtifact })
      if (item.failure) parts.push({ kind: 'error', text: t('failedTitle'), actions: item.position === failedAt ? failureNotice : <FailureReason retry={item.welcome} failure={item.failure} botId={botId} sending={sending} onResend={() => { void (botId ? retryCoordinatorTurn(botId) : retryCoordinatorTurn()).then(() => mutate()) }} /> })
      entries.push({ id: key, role: 'bot', at, parts, streaming, ...(item.stopped ? { stopped: true } : {}),
        actions: item.text && !streaming ? <MessageActions className={cn('items-start', REPLY_ACTIONS, item.position === lastReplyAt && 'pointer-coarse:opacity-100')}>
          <CopyAction text={replyCopyText(item.text)} />
          <AgentCitationsContext value={citations}><CitationSources text={item.text} /></AgentCitationsContext>
          {item.id && <MessageReactions reactions={reactions[item.id]} align="start" />}
        </MessageActions> : undefined })
    }
    if (failed) entries.push({ id: 'failed', role: 'person', at: Date.now(), text: splitReplyQuote(failed.text).text, status: 'failed', onRetry: () => { void deliver(failed.text, failed.withNotes, failed.retryOf) } })
    // Before the reply has anything to show: the Bot's turn, still empty, with its caret.
    if (data?.working && items.length > 0 && !stream.replies.length && !(lastSaid?.from === 'coordinator' && lastSaid.text) && !stopping)
      entries.push({ id: 'waiting', role: 'bot', at: Date.now(), parts: [], streaming: true })
    if (welcomeFailed && !items.length) entries.push({ id: 'welcome-failure', role: 'bot', at: Date.now(), parts: [{ kind: 'error', text: t('failedTitle'), actions: failureNotice }] })
    const empty = data && !items.length && !stream.replies.length && !data.error ? (data.enabled
      ? <p role="status">{tNav('writingWelcome')}</p>
      : <div className="flex flex-col gap-3"><p>{t('empty', { name })}</p>
        {!bot && <div className="flex flex-wrap gap-2">{STARTERS.map(key => <Button key={key} variant="outline" size="sm" className="rounded-full font-normal" onClick={() => setDraft(t(`starters.${key}`))}>{t(`starters.${key}`)}</Button>)}</div>}</div>) : undefined
    const notices = <>
      {(loadError || stream.error) && <FieldError className="text-xs">{t('loadError')}</FieldError>}
      {failedAt === null && !welcomeFailed && failureNotice}
      {!data?.error && <HostedUnavailableNotice botId={botId} />}
      {!refusal && (declined === 'quotaUsed' || !data?.error) && <QuotaNotice botId={botId} stopped={declined === 'quotaUsed'}
        retry={(label, disabled) => <RetryReplyButton botId={botId} onQueued={mutate} label={label} disabled={disabled} />} />}
      {unanswered && <Alert variant="destructive"><AlertTitle>{t('unavailable', { name })}</AlertTitle></Alert>}
      {botId && <SubagentLoginNeeds botId={botId} />}
      <PendingActions />
    </>
    return <AgentThemeProvider><AgentInteractionContext value={{ busy: sending || Boolean(data?.working), continueFromAnswer: prompt => post(prompt.trim()) }}>
      {/* The page's floating title pill sits over the top 56px on wide screens: the screen starts below it. */}
      <section ref={rootRef} aria-label={name} className="mikka-agent flex min-h-0 min-w-0 flex-1 flex-col md:pt-14">
        <Screen botId={botId} name={name} mark={avatar('pill')} entries={data ? entries : null} empty={empty} panels={compact ? undefined : panels} work={work.work}
          older={data?.historyBefore ? { loading: loadingHistory, onLoad: () => void loadHistory() } : undefined}
          working={working && !stopping} onStop={(working || sending) && !stopping ? () => { void stop() } : undefined}
          composer={{ ref: inputRef, label: bot ? t('inputTo', { name: bot.name }) : t('input'), placeholder, value: draft, onChange: updateDraft, sending, onSubmit: () => { void send() },
            attachmentScope: data?.botId ? { kind: 'bot', id: data.botId } : undefined, running: working && !stopping }}
          pending={[
            ...(replyQuote ? [{ id: 'reply-quote', name: replyQuote, meta: tMessage('quote'), onRemove: () => setReplyQuote(null) }] : []),
            ...(browser?.notes ?? []).map(note => ({ id: `note-${note.n}`, name: noteChipText(note), meta: tNavAll('Editor.richText.annotate'), onRemove: () => browser?.remove(note.n) })),
          ]}
          notices={notices}
          questions={factory.questions.map(question => ({ id: question.questionId, question: question.question, task: question.task, taskId: question.issueId ?? undefined,
            kind: question.type === 'permission' ? 'approval' : question.options.length ? 'decision' : 'question', ...(question.options.length ? { options: question.options.map(option => ({ id: option.value, title: option.label })) } : {}) }))}
          onAnswer={(id, text) => { const question = factory.questions.find(item => item.questionId === id); if (question) void factory.answer(question, text).then(error => { if (error) toast.error(actionError(error)) }) }}
          running={Object.values(sources ?? {}).filter(source => source.kind === 'run' && !source.finishedAt).length}
          onOpenTask={openTask} onOpenInbox={() => navigate({ section: 'suggestions' })} />
        <SelectionQuote root={rootRef} onQuote={quoteReply} />
      </section>
    </AgentInteractionContext></AgentThemeProvider>
  }

  return <AgentThemeProvider><AgentInteractionContext value={{ busy: sending || Boolean(data?.working), continueFromAnswer: prompt => post(prompt.trim()) }}>
  {/* The chat never widens what holds it: whatever a message carries scrolls or wraps inside its own box, and anything that still
      reaches past the column is clipped here instead of scrolling the whole page sideways. */}
  <section ref={rootRef} aria-label={name} className={cn('mikka-agent flex min-h-0 min-w-0 flex-1 flex-col overflow-x-clip', CHAT_SURFACE)}>
    {/* Follow the end while the person is there, never anchor rows to the top: the scroller re-anchors any person row
        whose element it has not seen, and a stored message remounts its pending row, so the chat jumped up the history.
        Rows render at their real height: an estimated height on a new row shifts the end by the difference. */}
    <MessageScrollerProvider key={stateKey} defaultScrollPosition={startAtEnd ? "end" : "start"} autoScroll>
      <FollowSentMessages count={data ? localSend.key === stateKey ? localSend.count : 0 : null} />
      <MessageScroller className="min-h-0 flex-1">
        {/* Full size, the header pill floats over the top of the chat: rows scrolled up fade out above it instead of
            running under it, so the top reads as a solid band in either theme and in the translucent desktop window (R-35). */}
        <MessageScrollerViewport ref={transcript} onScroll={event => { const node = event.currentTarget; const next = node.scrollHeight - node.scrollTop - node.clientHeight < 56; if (next !== following) setFollowing(next) }} aria-label={bot ? t('conversationWith', { name: bot.name }) : t('conversation')} className={cn(!compact && HEADER_FADE)}>
          <MessageScrollerContent className={cn('flex w-full min-w-0 max-w-full flex-col gap-5 pb-6', compact ? 'px-3 pt-4' : 'px-4 pt-24 sm:px-6')}>
            <ActivityExpansionContext value={expansion}>
            {data?.historyBefore && <Button variant="ghost" size="sm" disabled={loadingHistory} onClick={() => void loadHistory()}>{tCommon('loadMore')}</Button>}
            {/* A slow first load shows the shape of a conversation, not an empty page (state completeness). */}
            {!data && !loadError && <div role="status" aria-label={tCommon('loading')} className="flex flex-col gap-5">
              <Skeleton className="h-16 w-3/5 rounded-2xl" />
              <Skeleton className="h-11 w-2/5 self-end rounded-2xl" />
              <Skeleton className="h-24 w-2/3 rounded-2xl" />
            </div>}
            {/* The header pill and the 概览 panel already name the bot: an empty chat says one line, no third avatar (R-41). */}
            {welcomeFailed && !items.length && <div data-message-failure="welcome" className="flex w-full max-w-md flex-col gap-2 self-start">{failureNotice}</div>}
            {data && !items.length && !stream.replies.length && !data.error && (data.enabled
              ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">{avatar('pill', 'thinking')}{tNav('writingWelcome')}</p>
              : <div className="m-auto flex flex-col items-center gap-3">
                <p className="text-sm text-muted-foreground">{t('empty', { name })}</p>
                {/* The Coordinator's first chat offers a starting move: a chip fills the composer, the person sends it (states-05). */}
                {!bot && !embedded && <div className="flex max-w-md flex-wrap justify-center gap-2">{STARTERS.map(key => <Button key={key} variant="outline" size="sm" className="rounded-full font-normal" onClick={() => {
                  const text = t(`starters.${key}`)
                  setDraft(text)
                  const input = inputRef.current
                  if (input) { input.focus(); input.setSelectionRange(text.length, text.length) }
                }}>{t(`starters.${key}`)}</Button>)}</div>}
              </div>)}
            {/* Stored and streamed replies are one list: a stored reply takes the key of the stream it was shown from, so
                storing it keeps its row, text and chips in place instead of mounting them again (the chat flashed). */}
            {[...items.filter(item => !staleEvents.has(item.position)).map(item => ({ item, live: undefined, key: item.pending ? `pending-${item.position}` : item.streamId ?? item.position })),
              // After 停止 the reply in flight no longer draws as streaming (no cursor, no running activity) while it is stored.
              ...stream.replies.map(reply => ({ item: streamedItem(reply, stopping), live: stopping && reply.committedThrough === undefined ? { ...reply, committedThrough: -1 } : reply, key: reply.id }))].map(({ item, live, key }) => <Fragment key={key}>
              {!live && dividerAt === item.position && <UnreadDivider />}
              <MessageScrollerItem messageId={live ? live.id : String(item.position)} className={cn('[content-visibility:visible]', (live ? arriving(`stream-${live.id}`) : entering(item)) && ENTER)}
                {...(live ? { 'data-coordinator-stream-id': live.id, 'data-streaming': live.committedThrough === undefined } : item.from === 'event' ? {} : { [MESSAGE_POSITION_ATTR]: item.position })}>
              {item.from === 'event'
                ? item.notice
                  ? <QuotaSwitchLine notice={item.notice} botId={botId} />
                  : item.line ? <ChatEventLine line={item.line} citations={citations} /> : null
                : <ChatMessage from={item.from === 'person' ? 'person' : 'bot'} speaker={speaker} compact={compact} streaming={Boolean(live && live.committedThrough === undefined)}
                    // A tapped 建议 card: the same card, then only what it adds (R-21, R-40).
                    lead={item.suggestion && <SentSuggestion card={item.suggestion} compact={compact} />}
                    // Top to bottom as it happened: thinking, then the words and each tool after the words said before it.
                    // The same rows live and stored, so storing keeps them in place.
                    body={item.welcome ? null : item.from === 'coordinator'
                      ? <ReplyAnswer value={live ? null : answers.get(item.position) ?? null}>{replyRows(item, live).map((segment, index) => segment.kind === 'tools'
                        ? <AgentCitationsContext key={index} value={citations}><ReplyActivity tools={segment.tools} {...(index === 0 && item.activity ? { thinking: live ? liveThinking(live) : undefined, thought: item.activity.thought, reasoningAt: item.activity.reasoningAt } : {})} botId={botId} live={Boolean(live && live.committedThrough === undefined)} /></AgentCitationsContext>
                        : <CoordinatorReply key={index} text={segment.text} carded={cardsOf(item, Boolean(live)).join(',')} citations={live ? live.committedThrough === undefined ? liveCitations.streaming : liveCitations.settled : citations} isStreaming={Boolean(live && live.committedThrough === undefined)} />)}</ReplyAnswer>
                      : item.text && <PersonWords text={item.text} before={<>{item.quote && <ArtifactQuoteLine quote={item.quote} />}{item.notes?.map(note => <BrowserNoteLine key={note.n} note={note} />)}</>} />}
                    extras={<>{item.artifacts.length > 0 && <div className={cn('flex flex-col gap-2', embedded ? 'items-start gap-1.5' : 'w-full')}>
                      {item.artifacts.flatMap(id => { const artifact = data?.artifacts[id]; return artifact ? [embedded
                        ? <ArtifactChip key={id} artifact={artifact} active={id === embedded.activeArtifactId} onOpen={openArtifact} />
                        : <ArtifactReviewCard key={id} artifact={artifact} onOpen={openArtifact} />] : [] })}
                    </div>}
                    {cardsOf(item, Boolean(live)).map(id => {
                      const run = sources?.[id]
                      return run?.kind === 'run' ? <ThreadCard key={id} run={run} onOpen={showThread} onOpenTask={openTask} /> : null
                    })}</>}
                    // Copy and the pages it cites, on one line under the reply, only while it is hovered or tapped (R-83).
                    actions={item.text && !(live && live.committedThrough === undefined) && <MessageActions className={cn('-mt-1 items-start', REPLY_ACTIONS, item.position === lastReplyAt && 'pointer-coarse:opacity-100')}>
                      <CopyAction text={item.from === 'coordinator' ? replyCopyText(item.text) : splitReplyQuote(item.text).text} />
                      {item.from === 'coordinator' && <AgentCitationsContext value={citations}><CitationSources text={item.text} /></AgentCitationsContext>}
                    </MessageActions>}
                    copyText={item.text ? item.from === 'coordinator' ? replyCopyText(item.text) : splitReplyQuote(item.text).text : undefined}
                    sources={item.from === 'coordinator' && item.text ? <AgentCitationsContext value={citations}><CitationSources text={item.text} /></AgentCitationsContext> : undefined}
                    after={<>{item.id && <MessageReactions reactions={reactions[item.id]} align={item.from === 'person' ? 'end' : 'start'} />}
                    {item.stopped && <MessageFooter><p role="status">{t('stopped')}</p></MessageFooter>}
                    {item.failure && (item.position === failedAt
                      ? <div data-message-failure={item.welcome ? 'welcome' : 'live'} className={cn('flex w-full max-w-md flex-col gap-2', item.welcome ? 'self-start' : 'self-end')}>{failureNotice}</div>
                      : <MessageFooter className={cn(item.welcome ? 'self-start' : 'self-end')}><FailureReason retry={item.welcome} failure={item.failure} botId={botId} sending={sending} onResend={() => { if (item.welcome) void (botId ? retryCoordinatorTurn(botId) : retryCoordinatorTurn()).then(() => mutate()); else void deliver(item.text, false, item.position) }} /></MessageFooter>)}</>} />}
            </MessageScrollerItem>
            </Fragment>)}
            {failed && <MessageScrollerItem messageId="failed" data-testid="failed-message" className="[content-visibility:visible]">
              <Message align="end"><MessageContent>
                <span className="flex w-full min-w-0 items-center justify-end gap-2">
                  <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-destructive-foreground" />
                  <Bubble variant="secondary" align="end" className={cn(PERSON_BUBBLE, compact ? 'max-w-[90%]' : 'max-w-[min(26rem,80%)]')}><BubbleContent className="flex flex-col gap-1.5 rounded-2xl px-4 py-3 whitespace-pre-wrap"><PersonWords text={failed.text} /></BubbleContent></Bubble>
                </span>
                <span role="alert" className="flex items-center justify-end gap-1 self-end text-xs text-destructive-foreground">
                  {failed.message}
                  <Button variant="ghost" size="xs" className="text-foreground" disabled={sending} onClick={() => { void deliver(failed.text, failed.withNotes, failed.retryOf) }}>{tCommon('retry')}</Button>
                </span>
              </MessageContent></Message>
            </MessageScrollerItem>}
            {/* Before the reply has anything to show: the Trace's Thinking row. Once the reply streams, its own Trace takes
                over. It fades in (R-37: opacity on a duration) and leaves at once: an exit would keep its height after the
                reply lands and pull the scroll position back (coordinator-scroll.spec). */}
            {data?.working && items.length > 0 && !stream.replies.length && !(lastSaid?.from === 'coordinator' && lastSaid.text) && (stopping
              ? <Message align="start"><MessageContent><MessageFooter><p role="status">{t('stopped')}</p></MessageFooter></MessageContent></Message>
              : <div className={cn('flex', workingEnter && ENTER)}><ChatWaiting speaker={speaker} /></div>)}
            </ActivityExpansionContext>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <AnimatePresence initial={false}>
          {unread.showTop && <UnreadPill key="up" direction="up" count={unread.topCount} onJump={unread.jumpToDivider} onDismiss={unread.dismissTop} />}
          {unread.showBottom && <UnreadPill key="down" direction="down" count={unread.bottomCount} onJump={unread.jumpToLatest} onDismiss={unread.dismissBottom} />}
        </AnimatePresence>
        {!unread.showBottom && <MessageScrollerButton />}
      </MessageScroller>
    </MessageScrollerProvider>
    <div className={cn('flex w-full min-w-0 max-w-full flex-col gap-2', compact ? 'px-3 pb-3' : 'px-4 pb-4 sm:px-6')}>
      {(loadError || stream.error) && <FieldError className="text-xs">{t('loadError')}</FieldError>}
      {failedAt === null && !welcomeFailed && failureNotice}
      {/* Out of quota: after a turn stopped on it, or before the next message is sent. */}
      {/* On Mikka 默认 with no points here: said before sending (decision 2026-11-02-1450). */}
      {!data?.error && <HostedUnavailableNotice botId={botId} />}
      {!refusal && (declined === 'quotaUsed' || !data?.error) && <QuotaNotice botId={botId} stopped={declined === 'quotaUsed'}
        retry={(label, disabled) => <RetryReplyButton botId={botId} onQueued={mutate} label={label} disabled={disabled} />} />}
      {unanswered && <Alert variant="destructive"><AlertTitle>{t('unavailable', { name })}</AlertTitle></Alert>}
      {botId && <SubagentLoginNeeds botId={botId} />}
      <PendingActions />
      <ChatComposer ref={inputRef} label={bot ? t('inputTo', { name: bot.name }) : t('input')} placeholder={placeholder} value={draft} onChange={updateDraft} sending={sending} onSubmit={() => { void send() }} attachmentScope={data?.botId ? { kind: 'bot', id: data.botId } : undefined}
        running={working && !stopping} onStop={(working || sending) && !stopping ? () => { void stop() } : undefined}
        model={<BotModelPicker botId={botId ?? null} running={working || sending} />}
        quote={embedded?.quote || replyQuote || noteCount ? <div className="flex w-full min-w-0 flex-col items-start gap-0.5">
          {embedded?.quote && <ArtifactQuoteChip quote={embedded.quote} onRemove={embedded.clearQuote} />}
          {replyQuote && <QuoteChip slot="reply-quote-chip" text={replyQuote} onRemove={() => { setReplyQuote(null); inputRef.current?.focus() }} />}
          {browser?.notes.map(note => <BrowserNoteChip key={note.n} note={note} onRemove={() => browser.remove(note.n)} />)}
        </div> : undefined} />
    </div>
    <SelectionQuote root={rootRef} onQuote={quoteReply} />
  </section>
  </AgentInteractionContext></AgentThemeProvider>
}
