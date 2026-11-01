'use client'

import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { AnimatePresence } from 'motion/react'
import { withBasePath } from '@/lib/base-path'
import { useTranslations } from 'next-intl'
import { getCoordinatorChat, stopCoordinatorTurn, welcomeCoordinator, type CoordinatorChat as Chat } from '@/app/actions/coordinator'
import type { BotView } from '@/app/actions/bots'
import { BotAvatar, COORDINATOR_AVATAR } from '@/components/nav/bot-avatar'
import { cn } from '@/lib/utils'
import { useActionError } from '@/lib/use-action-error'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Message, MessageContent, MessageFooter } from '@/components/ui/message'
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport, useMessageScroller } from '@/components/ui/message-scroller'
import { Spinner } from '@/components/ui/spinner'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { CircleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { useLinkPreviews, type AgentCitations } from '@/components/workspace/agent-citations'
import { UserMessageText } from '@/components/workspace/user-message-text'
import { AgentInteractionContext } from '@/components/workspace/agent-interaction'
import { ReplyAnswer } from '@/components/workspace/agent-decision'
import { AgentThemeProvider } from '@/components/workspace/agent-theme'
import { openThread } from '@/components/workspace/workspace-navigation'
import { CoordinatorReply } from './coordinator-reply'
import { ChatComposer } from './chat-composer'
import { BotModelPicker } from './bot-model-picker'
import { useCoordinatorSubmit } from './use-coordinator-submit'
import { useCoordinatorStream } from './use-coordinator-stream'
import { ThreadCard } from './thread-card'
import { ToolsUsed } from './tools-used'
import { PendingActions } from './pending-actions'
import { SubagentLoginNeeds } from './subagent-login-needs'
import { UnreadDivider } from '@/components/chat/unread-divider'
import { UnreadPill } from '@/components/chat/unread-pill'
import { MESSAGE_POSITION_ATTR, useUnreadIndicators } from '@/lib/hooks/use-unread-indicators'
import { useArrivals } from '@/lib/hooks/use-arrivals'
import { openArtifact as openArtifactWindow } from '@/components/workspace/workspace-navigation'
import { ArtifactCard, ArtifactChip } from '@/components/artifacts/artifact-card'
import { ArtifactQuoteChip, ArtifactQuoteLine } from '@/components/artifacts/artifact-quote'
import type { ArtifactChatSlot } from '@/components/artifacts/artifact-viewer'
import { BrowserNoteChip, BrowserNoteLine, useBrowserNotesComposer } from '@/components/browser/browser-notes'
import { SentSuggestion } from '@/components/suggestions/mobile-card'
import { HostedRefusalNotice } from '@/components/billing/hosted-refusal-notice'
import { hostedRefusal } from '@/lib/billing/verification-client'
import { subscriptionRefusal } from '@/lib/subscription-refusal'
import { SubscriptionRefusalNotice } from './subscription-refusal-notice'
import { QuotaNotice, QuotaSwitchLine } from './quota-notice'
import { RetryReplyButton } from './retry-reply-button'
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

/** The SWR key of a chat: the Coordinator's, or one bot's. */
export function coordinatorChatKey(botId?: string | null) {
  return botId ? ['coordinator-chat', botId] as const : 'coordinator-chat'
}

/** The tools a reply used, less a dispatch that already shows as its thread card. */
function footerTools(item: Chat['items'][number]) {
  return [...new Set(item.tools.filter(tool => !((tool === 'dispatch_run' || tool === 'dispatch_bot_computer') && item.threads.length)))]
}

/** A message the person just sent brings the chat back to its end, wherever they had scrolled. */
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

export function CoordinatorChat({ onOpenIssue, prefill, placeholder, compact = false, embedded, bot, userId }: { onOpenIssue: (id: string) => void; prefill?: CoordinatorPrefill; placeholder?: string; compact?: boolean; embedded?: ArtifactChatSlot; bot?: BotView; userId?: string }) {
  const t = useTranslations('Coordinator')
  const tNav = useTranslations('Nav')
  const tCommon = useTranslations('Common')
  const botId = bot?.id ?? null
  const name = bot?.name ?? t('label')
  const avatar = (size: 'pill' | 'profile', mood?: 'thinking') => <BotAvatar {...(bot ? { color: bot.color, shape: bot.shape } : COORDINATOR_AVATAR)} size={size} mood={mood} />
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const actionError = useActionError()
  const reconnectStream = useRef<() => void>(() => {})
  const { data, mutate, error: loadError } = useSWR<Chat>(coordinatorChatKey(botId), () => botId ? getCoordinatorChat(botId) : getCoordinatorChat(), {
    refreshInterval: latest => latest?.working ? 2000 : 10000,
    onSuccess: () => reconnectStream.current(),
  })
  const stream = useCoordinatorStream({ botId, runId: data?.streamRunId, cursor: data?.cursor, persistedStreamIds: data?.persistedStreamIds, revalidate: mutate })
  useEffect(() => { reconnectStream.current = stream.reconnect }, [stream.reconnect])
  const [draft, setDraft] = useState('')
  // A draft belongs to the bot it was typed for. Switching bots remounts this
  // component (the page keys it by bot), so keep the text per conversation.
  const draftKey = userId ? `mikka:draft:${userId}:${botId ?? 'coordinator'}` : null
  const draftLoaded = useRef(false)
  useEffect(() => {
    if (!draftKey) return
    try {
      const saved = sessionStorage.getItem(draftKey)
      if (saved) setDraft(saved)
    } catch { /* storage may be unavailable; the draft then lives in memory only */ }
    draftLoaded.current = true
  }, [draftKey])
  function updateDraft(value: string) {
    setDraft(value)
    if (!draftKey || !draftLoaded.current) return
    try {
      if (value) sessionStorage.setItem(draftKey, value)
      else sessionStorage.removeItem(draftKey)
    } catch { /* storage may be unavailable */ }
  }
  const [sending, setSending] = useState(false)
  // A message that did not go stays in the chat as a failed bubble with 重试, as in iMessage and Slack. Retrying here
  // resends the same submission (same id), so it is stored once.
  // `after`: the last stored position when it failed.
  const [failed, setFailed] = useState<{ text: string; withNotes: boolean; message: string; after: number } | null>(null)
  const { submit, failureMessage } = useCoordinatorSubmit()
  const { mutate: mutateAll } = useSWRConfig()
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
  const items = useMemo(() => data?.items ?? [], [data])
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
  // 重试 on any failed reply, never on a wake still being retried by the server.
  const retry = <RetryReplyButton botId={botId} onQueued={mutate} />
  const wakeError = data?.error === 'wake_failed' || data?.error === 'wake_start_unconfirmed' || data?.error === 'wake_exhausted' ? data.error : null
  // With no Coordinator here, the person's last message gets no reply: show it as a failed turn instead of silence.
  // A failed turn's own line already says why; this one is only for a chat with no Coordinator to answer.
  const unanswered = data?.enabled === false && !data.error && items.findLast(item => item.from !== 'event')?.from === 'person'
  // No empty chats: the Coordinator, like every bot, writes its welcome first.
  const welcomed = useRef(false)
  useEffect(() => {
    if (!data?.enabled || items.length || data.working || data.error || welcomed.current) return
    welcomed.current = true
    void (botId ? welcomeCoordinator(botId) : welcomeCoordinator()).then(() => mutate())
  })
  const sentCount = useMemo(() => items.filter(item => item.from === 'person').length, [items])
  const rootRef = useRef<HTMLElement>(null)
  // Events are system lines, not messages; the person's own messages never count as unread.
  const unreadItems = useMemo(() => items.filter(item => item.from !== 'event').map(item => ({ position: item.position, messageId: item.id ?? String(item.position), own: item.from === 'person', reportable: !item.pending })), [items])
  const unread = useUnreadIndicators({ conversationId: botId ? `bot:${botId}` : 'coordinator', items: unreadItems, rootRef })
  const previews = useLinkPreviews(items.filter(item => item.from === 'coordinator').map(item => item.text))
  const sources = data?.sources
  const citations = useMemo<AgentCitations>(() => ({ sources: sources ?? {}, previews, onOpenIssue }), [sources, previews, onOpenIssue])
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

  // 停止: the turn ends on the server, keeping what it had said; the button waits until the chat stops working.
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
  async function deliver(text: string, withNotes = false): Promise<'sent' | 'failed' | 'skipped'> {
    if (!text || sending) return 'skipped'
    setSending(true)
    const notes = withNotes && browser?.notes.length ? [...browser.notes] : undefined
    const fail = (message: string | null) => {
      if (!message) return 'skipped' as const
      setFailed({ text, withNotes, message, after: items.at(-1)?.position ?? 0 })
      return 'failed' as const
    }
    try {
      const outcome = await submit(text, { quote: embedded?.quote, botId, notes })
      if (outcome.kind !== 'accepted') return fail(failureMessage(outcome))
      setFailed(current => current?.text === text ? null : current)
      embedded?.clearQuote()
      if (notes) browser?.removeMany(notes.map(note => note.n))
      await mutate()
      return 'sent'
    } catch { return fail(actionError()) } finally { setSending(false) }
  }
  /** Sends `text`; false if it did not go. */
  async function post(text: string, withNotes = false) {
    return await deliver(text, withNotes) === 'sent'
  }
  async function send(event?: FormEvent) {
    event?.preventDefault()
    const text = draft.trim()
    const result = await deliver(text, true)
    if (result === 'skipped') return
    // Sent or failed, the message leaves the composer. A failed one keeps its stored draft until the person types again,
    // so a reload or a switch to another bot puts it back in the composer.
    setDraft(current => current.trim() === text ? '' : current)
    if (result === 'failed') return
    if (draft.trim() === text && draftKey) { try { sessionStorage.removeItem(draftKey) } catch { /* storage may be unavailable */ } }
    const id = suggestion.current
    suggestion.current = null
    if (id) {
      await fetch(withBasePath(`/api/suggestions/${id}`), { method: 'DELETE', credentials: 'same-origin' }).catch(() => undefined)
      void mutateAll(key => typeof key === 'string' && key.includes('/api/suggestions'))
      void mutateAll('threads')
    }
  }

  const personBubble = cn('*:data-[slot=bubble-content]:bg-sidebar-primary *:data-[slot=bubble-content]:text-sidebar-primary-foreground', compact ? 'max-w-[90%]' : 'max-w-[min(26rem,80%)]')

  return <AgentThemeProvider><AgentInteractionContext value={{ busy: sending || Boolean(data?.working), continueFromAnswer: prompt => post(prompt.trim()) }}>
  {/* The chat never widens what holds it: whatever a message carries scrolls or wraps inside its own box, and anything that still
      reaches past the column is clipped here instead of scrolling the whole page sideways. */}
  <section ref={rootRef} aria-label={name} className="mikka-agent flex min-h-0 min-w-0 flex-1 flex-col overflow-x-clip">
    {/* Follow the end while the person is there, never anchor rows to the top: the scroller re-anchors any person row
        whose element it has not seen, and a stored message remounts its pending row, so the chat jumped up the history.
        Rows render at their real height: an estimated height on a new row shifts the end by the difference. */}
    <MessageScrollerProvider defaultScrollPosition="end" autoScroll>
      <FollowSentMessages count={data ? sentCount : null} />
      <MessageScroller className="min-h-0 flex-1">
        {/* Full size, the header pill floats over the top of the chat: rows scrolled up fade out above it instead of
            running under it, so the top reads as a solid band in either theme and in the translucent desktop window (R-35). */}
        <MessageScrollerViewport aria-label={bot ? t('conversationWith', { name: bot.name }) : t('conversation')} className={cn(!compact && HEADER_FADE)}>
          <MessageScrollerContent className={cn('flex w-full min-w-0 max-w-full flex-col gap-5 pb-6', compact ? 'px-3 pt-4' : 'px-4 pt-24 sm:px-6')}>
            {/* A slow first load shows the shape of a conversation, not an empty page (state completeness). */}
            {!data && !loadError && <div role="status" aria-label={tCommon('loading')} className="flex flex-col gap-5">
              <Skeleton className="h-16 w-3/5 rounded-2xl" />
              <Skeleton className="h-11 w-2/5 self-end rounded-2xl" />
              <Skeleton className="h-24 w-2/3 rounded-2xl" />
            </div>}
            {/* The header pill and the 概览 panel already name the bot: an empty chat says one line, no third avatar (R-41). */}
            {data && !items.length && !stream.replies.length && !data.error && (data.enabled
              ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">{avatar('pill', 'thinking')}{tNav('writingWelcome')}</p>
              : <p className="m-auto text-sm text-muted-foreground">{t('empty', { name })}</p>)}
            {items.map(item => <Fragment key={item.pending ? `pending-${item.position}` : item.position}>
              {unread.divider === item.position && <UnreadDivider />}
              <MessageScrollerItem messageId={String(item.position)} className={cn('[content-visibility:visible]', entering(item) && ENTER)} {...(item.from === 'event' ? {} : { [MESSAGE_POSITION_ATTR]: item.position })}>
              {item.from === 'event'
                ? item.notice
                  ? <QuotaSwitchLine notice={item.notice} botId={botId} />
                  : <p className="mx-auto max-w-full text-center text-xs text-muted-foreground wrap-break-word">{item.text.replace(/^\[Event\]\s*/, '')}</p>
                : <Message align={item.from === 'person' ? 'end' : 'start'}><MessageContent>
                    {/* A tapped 建议 card: the same card, then only what it adds (R-21, R-40). */}
                    {item.suggestion && <SentSuggestion card={item.suggestion} compact={compact} />}
                    {item.text && (item.from === 'coordinator'
                      ? <ReplyAnswer value={answers.get(item.position) ?? null}><CoordinatorReply text={item.text} citations={citations} /></ReplyAnswer>
                      : <Bubble variant="secondary" align="end" className={personBubble}><BubbleContent className="flex flex-col gap-1.5 rounded-2xl px-4 py-3 whitespace-pre-wrap">{item.quote && <ArtifactQuoteLine quote={item.quote} />}{item.notes?.map(note => <BrowserNoteLine key={note.n} note={note} />)}<UserMessageText text={item.text} /></BubbleContent></Bubble>)}
                    {item.artifacts.length > 0 && <div className={cn('flex flex-col gap-2', embedded ? 'items-start gap-1.5' : 'w-full')}>
                      {item.artifacts.flatMap(id => { const artifact = data?.artifacts[id]; return artifact ? [embedded
                        ? <ArtifactChip key={id} artifact={artifact} active={id === embedded.activeArtifactId} onOpen={openArtifact} />
                        : <ArtifactCard key={id} artifact={artifact} onOpen={openArtifact} />] : [] })}
                    </div>}
                    {item.threads.map(id => {
                      const run = sources?.[id]
                      return run?.kind === 'run' ? <ThreadCard key={id} run={run} onOpen={showThread} /> : null
                    })}
                    {item.stopped && <MessageFooter><p role="status">{t('stopped')}</p></MessageFooter>}
                    {footerTools(item).length > 0 && <MessageFooter><ToolsUsed tools={footerTools(item)} /></MessageFooter>}
                  </MessageContent></Message>}
            </MessageScrollerItem>
            </Fragment>)}
            {stream.replies.map(reply => <MessageScrollerItem key={reply.id} messageId={reply.id} data-coordinator-stream-id={reply.id} data-streaming={reply.committedThrough === undefined} className={cn('[content-visibility:visible]', arriving(`stream-${reply.id}`) && ENTER)}>
              <Message align="start"><MessageContent>
                <CoordinatorReply text={reply.text} citations={citations} isStreaming={reply.committedThrough === undefined} />
              </MessageContent></Message>
            </MessageScrollerItem>)}
            {failed && <MessageScrollerItem messageId="failed" data-testid="failed-message" className="[content-visibility:visible]">
              <Message align="end"><MessageContent>
                <span className="flex w-full min-w-0 items-center justify-end gap-2">
                  <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-destructive" />
                  <Bubble variant="secondary" align="end" className={personBubble}><BubbleContent className="rounded-2xl px-4 py-3 whitespace-pre-wrap"><UserMessageText text={failed.text} /></BubbleContent></Bubble>
                </span>
                <span role="alert" className="flex items-center justify-end gap-1 self-end text-xs text-destructive">
                  {failed.message}
                  <Button variant="ghost" size="xs" className="text-foreground" disabled={sending} onClick={() => { void deliver(failed.text, failed.withNotes) }}>{tCommon('retry')}</Button>
                </span>
              </MessageContent></Message>
            </MessageScrollerItem>}
            {/* The working line fades in (R-37: opacity on a duration). It leaves at once: an exit would keep its height
                after the reply lands and pull the scroll position back (coordinator-scroll.spec). */}
            {data?.working && items.length > 0 && <p role="status" className={cn('flex items-center gap-2 text-sm text-muted-foreground', workingEnter && ENTER)}><Spinner />{t('working')}</p>}
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
      {refusal && <HostedRefusalNotice code={refusal} retry={retry} />}
      {declined && declined !== 'quotaUsed' && <SubscriptionRefusalNotice notice={declined} retry={retry} />}
      {/* Out of quota: after a turn stopped on it, or before the next message is sent. */}
      {!refusal && (declined === 'quotaUsed' || !data?.error) && <QuotaNotice botId={botId} stopped={declined === 'quotaUsed'}
        retry={(label, disabled) => <RetryReplyButton botId={botId} onQueued={mutate} label={label} disabled={disabled} />} />}
      {data?.error && !data.working && !refusal && !declined && <Alert variant="destructive">{wakeError ? <AlertTitle>{t(`wakeErrors.${wakeError}`)}</AlertTitle> : <><AlertTitle>{t('failedTitle')}</AlertTitle><AlertDescription>{data.error}</AlertDescription><AlertAction>{retry}</AlertAction></>}</Alert>}
      {unanswered && <Alert variant="destructive"><AlertTitle>{t('unavailable', { name })}</AlertTitle></Alert>}
      {botId && <SubagentLoginNeeds botId={botId} />}
      <PendingActions />
      <ChatComposer ref={inputRef} label={bot ? t('inputTo', { name: bot.name }) : t('input')} placeholder={placeholder} value={draft} onChange={updateDraft} sending={sending || stopping} editableWhileSending={stopping} onSubmit={() => { void send() }}
        running={working && !stopping} onStop={(working || sending) && !stopping ? () => { void stop() } : undefined}
        model={<BotModelPicker botId={botId ?? null} />}
        quote={embedded?.quote || noteCount ? <div className="flex w-full min-w-0 flex-col items-start gap-0.5">
          {embedded?.quote && <ArtifactQuoteChip quote={embedded.quote} onRemove={embedded.clearQuote} />}
          {browser?.notes.map(note => <BrowserNoteChip key={note.n} note={note} onRemove={() => browser.remove(note.n)} />)}
        </div> : undefined} />
    </div>
  </section>
  </AgentInteractionContext></AgentThemeProvider>
}
