'use client'

import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { withBasePath } from '@/lib/base-path'
import { useTranslations } from 'next-intl'
import { getCoordinatorChat, welcomeCoordinator, type CoordinatorChat as Chat } from '@/app/actions/coordinator'
import type { BotView } from '@/app/actions/bots'
import { BotAvatar, COORDINATOR_AVATAR } from '@/components/nav/bot-avatar'
import { cn } from '@/lib/utils'
import { useActionError } from '@/lib/use-action-error'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Message, MessageContent, MessageFooter } from '@/components/ui/message'
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from '@/components/ui/message-scroller'
import { Spinner } from '@/components/ui/spinner'
import { useLinkPreviews, type AgentCitations } from '@/components/workspace/agent-citations'
import { AgentInteractionContext } from '@/components/workspace/agent-interaction'
import { AgentThemeProvider } from '@/components/workspace/agent-theme'
import { IssueThreadPanel } from '@/components/workspace/issue-thread-panel'
import { CoordinatorReply } from './coordinator-reply'
import { ChatComposer } from './chat-composer'
import { useCoordinatorSubmit } from './use-coordinator-submit'
import { ThreadCard } from './thread-card'
import { PendingActions } from './pending-actions'
import { UnreadDivider } from '@/components/chat/unread-divider'
import { UnreadPill } from '@/components/chat/unread-pill'
import { MESSAGE_POSITION_ATTR, useUnreadIndicators } from '@/lib/hooks/use-unread-indicators'
import dynamic from 'next/dynamic'
import { ArtifactCard, ArtifactChip } from '@/components/artifacts/artifact-card'
import { ArtifactQuoteChip, ArtifactQuoteLine } from '@/components/artifacts/artifact-quote'
import type { ArtifactChatSlot } from '@/components/artifacts/artifact-viewer'
import { BrowserNoteChip, BrowserNoteLine, useBrowserNotesComposer } from '@/components/browser/browser-notes'
import { SentSuggestion } from '@/components/suggestions/mobile-card'

const ArtifactViewer = dynamic(() => import('@/components/artifacts/artifact-viewer').then(module => module.ArtifactViewer), { ssr: false })

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

/**
 * The person's conversation with their Coordinator, which dispatches agents to
 * issues, or with one of their bots: a bot runs on the same harness with its
 * own conversation, memory and name. Artifacts agents hand over show as cards
 * under a reply and open the reader; inside the reader the same chat runs
 * `embedded`, with chips instead of cards and the quote from the artifact in
 * the composer.
 */
export function CoordinatorChat({ onOpenIssue, prefill, placeholder, compact = false, embedded, bot, userId }: { onOpenIssue: (id: string) => void; prefill?: CoordinatorPrefill; placeholder?: string; compact?: boolean; embedded?: ArtifactChatSlot; bot?: BotView; userId?: string }) {
  const t = useTranslations('Coordinator')
  const tNav = useTranslations('Nav')
  const botId = bot?.id ?? null
  const name = bot?.name ?? t('label')
  const avatar = (size: 'pill' | 'profile', mood?: 'thinking') => <BotAvatar {...(bot ? { color: bot.color, shape: bot.shape } : COORDINATOR_AVATAR)} size={size} mood={mood} />
  const [viewing, setViewing] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const actionError = useActionError()
  const { data, mutate, error: loadError } = useSWR<Chat>(coordinatorChatKey(botId), () => botId ? getCoordinatorChat(botId) : getCoordinatorChat(), {
    refreshInterval: latest => latest?.working ? 2000 : 10000,
  })
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
  const [sendError, setSendError] = useState<string | null>(null)
  const { submit, failureMessage } = useCoordinatorSubmit()
  const { mutate: mutateAll } = useSWRConfig()
  // A thread card opens its conversation in place of the chat; back returns here (R-66).
  const [openThread, setOpenThread] = useState<{ issueId: string; runId: string } | null>(null)
  // Notes pinned in the browser wait in this composer while it is the chat on screen (not inside the reader, not under an open thread).
  const browser = useBrowserNotesComposer(!embedded && !openThread)
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
  // No empty chats: the Coordinator, like every bot, writes its welcome first.
  const welcomed = useRef(false)
  useEffect(() => {
    if (!data?.enabled || items.length || data.working || welcomed.current) return
    welcomed.current = true
    void (botId ? welcomeCoordinator(botId) : welcomeCoordinator()).then(() => mutate())
  })
  const rootRef = useRef<HTMLElement>(null)
  // Events are system lines, not messages; the person's own messages never count as unread.
  const unreadItems = useMemo(() => items.filter(item => item.from !== 'event').map(item => ({ position: item.position, messageId: item.id ?? String(item.position), own: item.from === 'person', reportable: !item.pending })), [items])
  const unread = useUnreadIndicators({ conversationId: botId ? `bot:${botId}` : 'coordinator', items: unreadItems, rootRef })
  const previews = useLinkPreviews(items.filter(item => item.from === 'coordinator').map(item => item.text))
  const sources = data?.sources
  const citations = useMemo<AgentCitations>(() => ({ sources: sources ?? {}, previews, onOpenIssue }), [sources, previews, onOpenIssue])
  const quotes = useMemo(() => items.flatMap(item => item.quote ? [item.quote] : []), [items])
  // An artifact handed over shows here first; the Artifact page and a thread's 「Artifact · N」 refresh with it.
  const artifactIds = useMemo(() => items.flatMap(item => item.artifacts).join(','), [items])
  useEffect(() => {
    if (!artifactIds) return
    void mutateAll(key => key === 'artifacts' || (Array.isArray(key) && key[0] === 'run-artifacts'))
  }, [artifactIds, mutateAll])
  const openArtifact = embedded?.openArtifact ?? setViewing
  // A quote just picked in the reader: put the cursor where the request goes.
  useEffect(() => { if (embedded?.quote) inputRef.current?.focus() }, [embedded?.quote])

  /** Sends `text` to the Coordinator or bot, with the browser's notes when `withNotes`; false if it did not go. */
  async function post(text: string, withNotes = false) {
    if (!text || sending) return false
    setSending(true)
    setSendError(null)
    const notes = withNotes && browser?.notes.length ? [...browser.notes] : undefined
    try {
      const outcome = await submit(text, { quote: embedded?.quote, botId, notes })
      if (outcome.kind !== 'accepted') { setSendError(failureMessage(outcome)); return false }
      embedded?.clearQuote()
      if (notes) browser?.removeMany(notes.map(note => note.n))
      await mutate()
      return true
    } catch { setSendError(actionError()); return false } finally { setSending(false) }
  }
  async function send(event?: FormEvent) {
    event?.preventDefault()
    const text = draft.trim()
    if (!await post(text, true)) return
    setDraft(current => current.trim() === text ? '' : current)
    if (draft.trim() === text && draftKey) { try { sessionStorage.removeItem(draftKey) } catch { /* storage may be unavailable */ } }
    const id = suggestion.current
    suggestion.current = null
    if (id) {
      await fetch(withBasePath(`/api/suggestions/${id}`), { method: 'DELETE', credentials: 'same-origin' }).catch(() => undefined)
      void mutateAll(key => typeof key === 'string' && key.includes('/api/suggestions'))
      void mutateAll('threads')
    }
  }

  if (openThread) return <section aria-label={name} data-slot="thread-view" className="flex min-h-0 flex-1 flex-col">
    <IssueThreadPanel issueId={openThread.issueId} runId={openThread.runId} back={name} onClose={() => setOpenThread(null)} />
  </section>

  return <AgentThemeProvider><AgentInteractionContext value={{ busy: sending || Boolean(data?.working), continueFromAnswer: prompt => post(prompt.trim()) }}>
  <section ref={rootRef} aria-label={name} className="mikka-agent flex min-h-0 flex-1 flex-col">
    <MessageScrollerProvider defaultScrollPosition="end">
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport aria-label={bot ? t('conversationWith', { name: bot.name }) : t('conversation')}>
          <MessageScrollerContent className={cn('flex w-full min-w-0 max-w-full flex-col gap-5 pb-6', compact ? 'px-3 pt-4' : 'px-4 pt-18 sm:px-6')}>
            {data && !items.length && (data.enabled
              ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">{avatar('pill', 'thinking')}{tNav('writingWelcome')}</p>
              : <div className="flex flex-1 flex-col items-center justify-center gap-3">{avatar('profile')}<p className="text-sm font-medium">{name}</p></div>)}
            {items.map(item => <Fragment key={item.pending ? `pending-${item.position}` : item.position}>
              {unread.divider === item.position && <UnreadDivider />}
              <MessageScrollerItem messageId={String(item.position)} scrollAnchor={item.from === 'person'} {...(item.from === 'event' ? {} : { [MESSAGE_POSITION_ATTR]: item.position })}>
              {item.from === 'event'
                ? <p className="mx-auto max-w-full text-center text-xs text-muted-foreground wrap-break-word">{item.text.replace(/^\[Event\]\s*/, '')}</p>
                : <Message align={item.from === 'person' ? 'end' : 'start'}><MessageContent>
                    {/* A tapped 建议 card: the same card, then only what it adds (R-21, R-40). */}
                    {item.suggestion && <SentSuggestion card={item.suggestion} compact={compact} />}
                    {item.text && (item.from === 'coordinator'
                      ? <CoordinatorReply text={item.text} citations={citations} />
                      : <Bubble variant="secondary" align="end" className={cn('*:data-[slot=bubble-content]:bg-sidebar-primary *:data-[slot=bubble-content]:text-sidebar-primary-foreground', compact ? 'max-w-[90%]' : 'max-w-[min(26rem,80%)]')}><BubbleContent className="flex flex-col gap-1.5 rounded-2xl px-4 py-3 whitespace-pre-wrap">{item.quote && <ArtifactQuoteLine quote={item.quote} />}{item.notes?.map(note => <BrowserNoteLine key={note.n} note={note} />)}{item.text}</BubbleContent></Bubble>)}
                    {item.artifacts.length > 0 && <div className={cn('flex flex-col gap-2', embedded ? 'items-start gap-1.5' : 'w-full')}>
                      {item.artifacts.flatMap(id => { const artifact = data?.artifacts[id]; return artifact ? [embedded
                        ? <ArtifactChip key={id} artifact={artifact} active={id === embedded.activeArtifactId} onOpen={openArtifact} />
                        : <ArtifactCard key={id} artifact={artifact} onOpen={openArtifact} />] : [] })}
                    </div>}
                    {item.threads.map(id => {
                      const run = sources?.[id]
                      return run?.kind === 'run' ? <ThreadCard key={id} run={run} onOpen={setOpenThread} /> : null
                    })}
                    {footerTools(item).length > 0 && <MessageFooter>{t('usedTools', { tools: footerTools(item).join(', ') })}</MessageFooter>}
                  </MessageContent></Message>}
            </MessageScrollerItem>
            </Fragment>)}
            {data?.working && items.length > 0 && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />{t('working')}</p>}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        {unread.showTop && <UnreadPill direction="up" count={unread.topCount} onJump={unread.jumpToDivider} onDismiss={unread.dismissTop} />}
        {unread.showBottom ? <UnreadPill direction="down" count={unread.bottomCount} onJump={unread.jumpToLatest} onDismiss={unread.dismissBottom} /> : <MessageScrollerButton />}
      </MessageScroller>
    </MessageScrollerProvider>
    <div className={cn('flex w-full min-w-0 max-w-full flex-col gap-2', compact ? 'px-3 pb-3' : 'px-4 pb-4 sm:px-6')}>
      {loadError && <p role="alert" className="text-xs text-destructive">{t('loadError')}</p>}
      {data?.error && !data.working && <Alert variant="destructive"><AlertTitle>{t('failedTitle')}</AlertTitle><AlertDescription>{data.error}</AlertDescription></Alert>}
      {sendError && <p role="alert" className="text-xs text-destructive">{sendError}</p>}
      <PendingActions />
      <ChatComposer ref={inputRef} label={bot ? t('inputTo', { name: bot.name }) : t('input')} placeholder={placeholder} value={draft} onChange={updateDraft} sending={sending} onSubmit={() => { void send() }}
        quote={embedded?.quote || noteCount ? <div className="flex w-full min-w-0 flex-col items-start gap-0.5">
          {embedded?.quote && <ArtifactQuoteChip quote={embedded.quote} onRemove={embedded.clearQuote} />}
          {browser?.notes.map(note => <BrowserNoteChip key={note.n} note={note} onRemove={() => browser.remove(note.n)} />)}
        </div> : undefined} />
    </div>
    {!embedded && viewing && <ArtifactViewer artifactId={viewing} onArtifactChange={setViewing} onClose={() => setViewing(null)}
      bot={{ name, avatar: avatar('pill') }} quotes={quotes}
      chat={slot => <CoordinatorChat onOpenIssue={onOpenIssue} compact embedded={slot} bot={bot} />} />}
  </section>
  </AgentInteractionContext></AgentThemeProvider>
}
