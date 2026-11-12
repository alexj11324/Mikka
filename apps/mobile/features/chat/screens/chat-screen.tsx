import { mobileMessages } from '@/lib/messages'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Keyboard } from 'react-native'
import { StyleSheet, View } from 'react-native'
import { ChatMessageList, type ChatListHandle } from '@/features/chat/components/chat-message-list'
import { chatHistoryPath, chatUpdatePath, mergeChatHistory, mergeChatRead, personalReadback, olderThrough, type ChatHistoryPage, type ChatRead } from '@/features/chat/model/chat-pages'
import { latestOwnIndex } from '@/features/chat/model/chat-layout'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { uuid } from 'expo'
import { Spinner } from '@/components/icons'
import { ListTopFade } from '@/components/NavBar'
import { useScrolledUnderBar } from '@/components/BarBackdrop'
import { runIcon } from '@/lib/thread-icon'
import { Arrival, BotBubble, EventLine, MessageActions, MessageRow, MyBubble, OutgoingBubble, Reactions, ThreadCard, TimeSeparator, useChatPhotos } from '@/components/chat'
import { myReaction, toggled, withMine } from '@/lib/reactions'
import { Markdown } from '@/components/Markdown'
import { OfflineBanner } from '@/components/OfflineBanner'
import { OpenUIReply } from '@/components/OpenUI'
import { PendingActions } from '@/components/PendingActions'
import { Text } from '@/components/Text'
import { Composer } from '@/features/chat/components/chat-composer'
import { GlassButton } from '@/components/GlassButton'
import { api } from '@/lib/api'
import { outgoing, type Attachment } from '@/lib/attachments'
import { shortWhen } from '@/lib/clock'
import { separatorLabel, startsGroup } from '@/lib/chat-time'
import type { HeldMessage } from '@/lib/message-actions'
import { plainText, quotable } from '@/lib/quote'
import { canAnswerCard, outgoingKey, personalMessage, unsettled } from '@/lib/outbox'
import { apiCache } from '@/lib/api-cache'
import { acknowledgedPersonalMessages, usePersonalDelivery } from '@/features/chat/components/personal-delivery'
import { askForPush, usePushState } from '@/lib/push-state'
import { runName, type BotPage, type Chat, type CitationSource, type PendingAction } from '@/lib/types'
import { ChatHeader } from '@/features/chat/components/chat-header'
import { menuTasks } from '@/features/chat/model/chat-header-menu'
import { useTasks } from '@/features/tasks/components/task-list'
import { AttemptIcon } from '@/features/tasks/components/task-icons'
import { ReviewSummaryRow } from '@/features/review/components/review-summary-row'
import { reviewHref } from '@/features/review/model/routes'
import { ATTEMPT_WORD, attemptState } from '@/features/tasks/model/task-groups'
import { ChatSelectableText } from '@/features/chat/components/chat-selectable-text'
import { ChatSelectionBar } from '@/features/chat/components/chat-selection-bar'
import { ChatQueueCard } from '@/features/chat/components/chat-queue-card'
import { ADD_TO_CHAT, endsSelection, quotedMessage, selectionQuote, type Rect, type SelectionAction } from '@/features/chat/model/chat-selection'
import { nextQueueCheck, queuedItems } from '@/features/chat/model/chat-queue'
import { FailedReply } from '@/components/FailedReply'
import { eventText, questionCard } from '@/lib/event-line'
import { waitingLabel } from '@/lib/waiting'
import { useLiveApi, useRefresh } from '@/lib/useApi'
import { listRef, UNRESOLVED_LIVE_ID } from '@/lib/live'
import { pendingActionsDeadline } from '@/lib/live-client'
import { useStop } from '@/lib/useStop'
import { useEveChat } from '@/lib/eve-chat'
import { activeTurn } from 'eve/events'
import { EveInteractions } from '@/features/chat/components/eve-interactions'
import { eveChatItems, generatedCardDocument } from '@/features/chat/model/eve-messages'
import { StopFailed } from '@/components/StopFailed'
import { ReadNotice } from '@/components/ReadNotice'
import { ChatScrollToLatest } from '@/components/ChatScrollToLatest'
import { useReducedMotionPreference } from '@/lib/reduced-motion'
import { runInfoLine } from '@/lib/run-info'
import { useHome } from '@/lib/home'
import { colors } from '@/lib/theme'

/**
 * A chat with a bot; the Coordinator is one (R-06): the bot's name in a pill,
 * the threads behind the right button, the composer at the bottom. Reads again
 * when the server pushes the chat's key (a message, a turn, a run it cites). Below the messages sit the proposals waiting for the
 * person (approve or decline, as on the web); `focus` marks the one a push
 * was about. OpenUI cards are drawn natively (components/OpenUI.tsx).
 */
function ChatScreenSession({ botId, name, color, shape, draft, focus, compose, composerAccessory, composerNotice }: { botId: string | null; name: string; color?: string; shape?: string; draft?: string; focus?: string; compose?: boolean; composerAccessory?: ReactNode | ((running: boolean) => ReactNode); composerNotice?: ReactNode }) {
  const [quote, setQuote] = useState<string | null>(null)
  const self = botId ?? 'coordinator'
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const list = useRef<ChatListHandle>(null)
  const [atLatest, setAtLatest] = useState(true)
  const underBar = useScrolledUnderBar()
  const photos = useChatPhotos()
  // The composer floats over the end of the list; the list leaves room for it.
  const [composerHeight, setComposerHeight] = useState(90)
  const path = `/api/mobile/chat${botId ? `?bot=${botId}` : ''}`
  const homeData = useHome().data
  const home = homeData?.live?.workspaceId
  const homeBots = homeData?.bots
  // The web's chat key (components/coordinator/coordinator-chat.tsx) on the person's home channel; a turn's lease
  // running out has no write, so the server names it as a deadline.
  // A push reads only what is new since the last read, and merges it into what is shown (#1408).
  const personalScope = homeData?.user.id && home ? JSON.stringify(['personal-send', homeData.user.id, home, self]) : null
  const readChat = useCallback(async (path: string) => {
    const previous = apiCache.get<ChatRead>(path)
    const acknowledged = acknowledgedPersonalMessages(personalScope)
    const next = await api<ChatRead>(chatUpdatePath(path, previous))
    const latest = apiCache.get<ChatRead>(path)
    const merged = mergeChatRead(latest, next)
    return merged === latest ? merged : personalReadback(merged, acknowledged)
  }, [personalScope])
  const { data, error, reload, reloadAfterWrite, setData } = useLiveApi<ChatRead>(path, chat => ({
    refs: [{ kind: 'bot_chat', id: chat?.botId && chat.live?.workspaceId ? chat.botId : UNRESOLVED_LIVE_ID, scope: chat?.live?.workspaceId ?? null }],
    minIntervalMs: 2_000, deadline: chat?.live?.deadline,
  }), readChat)
  const agent = useEveChat(botId, Boolean(data), reload, homeData?.user.id, home)
  useEffect(() => { if (data && agent.session) void agent.resume().catch(() => undefined) }, [data, agent.session?.sessionId, agent.resume])
  const serviceUnavailable = data?.enabled === false
  const serviceRefresh = useRefresh(reload)
  // The person's proposals: the web's key (components/coordinator/pending-actions.tsx), on the same home channel.
  // The title menu's threads: read when the chat opens, again when a thread list changes; never while idle.
  // The title menu's tasks: the ones this bot dispatched (the Coordinator's are its bot row's).
  const ownBotId = self === 'coordinator' ? homeBots?.find(item => item.coordinator)?.id : self
  const tasks = useTasks(Boolean(ownBotId), ownBotId)
  const pending = useLiveApi<PendingAction[]>('/api/pending-actions', items => ({
    refs: [listRef('pending_actions', home)], deadline: pendingActionsDeadline(items),
  }))
  const apiContext = apiCache.context()
  const scope = data ? personalScope : null
  const received = useMemo(() => new Set([...(data?.acknowledgedBeforeRead ?? []), ...(data?.items.flatMap(item => item.from === 'person' && item.submissionId ? [item.submissionId] : []) ?? [])]), [data?.items, data?.acknowledgedBeforeRead])
  const personal = usePersonalDelivery(scope, received, agent.sendMessage, reloadAfterWrite)
  const outbox = personal.rows
  const [text, setText] = useState(draft ?? '')
  const working = agent.status === 'busy' || outbox.some(item => item.phase === 'sending')
  const push = usePushState()
  const reduceMotion = useReducedMotionPreference()
  // Opened from a push about a proposal: its card sits at the end of the chat, which is where the chat opens.
  const showFocus = () => list.current?.toLatest(!reduceMotion)
  // Scrolling to the top loads the page before, a page at a time.
  const olderRequest = useRef<object | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  useEffect(() => { olderRequest.current = null; setLoadingOlder(false) }, [path, apiContext])
  const loadOlder = async () => {
    const through = olderThrough(data)
    if (through === null || olderRequest.current) return
    const request = {}; olderRequest.current = request
    setLoadingOlder(true)
    try {
      const page = await api<ChatHistoryPage>(chatHistoryPath(path, through))
      apiCache.commit(apiContext, () => { if (olderRequest.current === request) setData(current => current && mergeChatHistory(current, page, through)) })
    } catch { /* the next scroll to the top tries again */ }
    finally { if (olderRequest.current === request) { olderRequest.current = null; setLoadingOlder(false) } }
  }

  useEffect(() => { if (draft) setText(draft) }, [draft])

  const allItems = useMemo(() => {
    const stored = data?.items ?? []
    return [...stored, ...eveChatItems({ messages: agent.messages, events: agent.events, session: agent.session }, stored)]
  }, [data?.items, agent.messages, agent.events, agent.session])
  const sources = data?.sources ?? {}
  // Queued messages wait above the composer, not in the conversation (#1408 Phase 3). The screen looks again when the
  // oldest pending message would turn queued: a UI timer, never a read.
  const sentWhileWorking = useRef(new Set<string>())
  const [now, setNow] = useState(Date.now)
  const queueCheck = nextQueueCheck(allItems, agent.status === 'busy', now)
  useEffect(() => {
    if (queueCheck === null) return
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, queueCheck - Date.now()))
    return () => clearTimeout(timer)
  }, [queueCheck])
  const queue = queuedItems(allItems, agent.status === 'busy', now, sentWhileWorking.current)
  const items = queue.length ? allItems.filter(item => !queue.includes(item)) : allItems
  // 选择文本: one message's words are selectable where they are; capsules above the composer act on the selection.
  const [selection, setSelection] = useState<{ key: number; text: string; selected: string } | null>(null)
  const selectionRect = useRef<Rect | null>(null)
  const touch = useRef<{ x: number; y: number; at: number } | null>(null)
  useEffect(() => { setSelection(null) }, [self, apiContext])
  const toggleSelection = (key: number, words: string) => {
    Keyboard.dismiss()
    selectionRect.current = null
    setSelection(current => current?.key === key ? null : { key, text: plainText(words), selected: plainText(words) })
  }
  const onSelected = useCallback((selected: string) => setSelection(current => current && current.selected !== selected ? { ...current, selected } : current), [])
  // What the chat held when it opened just appears; anything after it rises in (Arrival).
  const opened = useRef<{ chat: string; last: number } | null>(null)
  const chatKey = `${self}:${apiContext}`
  if (data && opened.current?.chat !== chatKey) opened.current = { chat: chatKey, last: items.reduce((last, item) => Math.max(last, item.position), -1) }
  const arrived = (position: number) => Boolean(opened.current && position > opened.current.last)
  // Only a message sent on this visit is anchored under the bar with room for the reply (v0); opening the chat,
  // older pages and pushes keep the latest message against the composer.
  const [sentHere, setSentHere] = useState(false)
  const anchorIndex = sentHere ? latestOwnIndex(items, item => item.from === 'person' && arrived(item.position)) : undefined
  // The one action row goes under the bot's latest reply, once it has finished (#1386).
  const latestReply = items.reduce((last, item, index) => item.from === 'coordinator' && item.text ? index : item.from === 'person' ? -1 : last, -1)
  // A card is answered once the person has written after it (here or anywhere else).
  const lastMine = items.reduce((last, item, index) => item.from === 'person' ? index : last, -1)
  const proactive = items.some((item, index) => item.from === 'coordinator' && items[index - 1]?.from === 'event')

  // iOS asks once; the moment is the first message the Coordinator sent on its own, not app launch.
  useEffect(() => { if (proactive && push === 'undetermined') void askForPush() }, [proactive, push])

  // A cited task or a task's thread opens the task (2026-11-07: a thread opens only inside its task).
  const open = (source: CitationSource) => {
    if (source.kind === 'issue') router.push(`/task/${source.id}`)
    else if (source.issue) router.push(`/task/${source.issue.id}`)
    else router.push(`/thread/${source.id}`)
  }

  const send = async (typed: string, attachments: Attachment[] = [], sourceCardId?: string) => {
    if (!scope || serviceUnavailable || agent.status === 'resuming') return false
    const pendingSends = personal.read().filter(item => !received.has(item.id))
    if (sourceCardId && !canAnswerCard(pendingSends, sourceCardId)) return false
    // While words are selected, what is typed answers them: it goes out quoting the selection.
    const words = selection && !quote && typed.trim() ? quotedMessage(selectionQuote(selection.selected, selection.text), typed) : typed
    setSelection(null)
    // The sent message rises to the top of the chat, blank space under it for the reply (v0).
    setSentHere(true)
    list.current?.toLatest(!reduceMotion)
    const { text: message, images } = outgoing(words, attachments)
    if (working) sentWhileWorking.current.add(message)
    const context = apiCache.context()
    const targetBotId = data?.botId ?? botId
    const held = sourceCardId ? unsettled(pendingSends, message, images, self, context, sourceCardId) : undefined
    const previous = sourceCardId ? pendingSends.find(item => item.sourceCardId === sourceCardId) : undefined
    // A lost acknowledgement may have committed. Only its original body and ID can be sent again.
    if (previous && !held && (previous.phase !== 'failed' || previous.error === mobileMessages.Coordinator.sendUncertain)) return false
    const item = held ?? personalMessage(outgoingKey(uuid.v4), message, images, { botId: targetBotId, chatKey: self, context, sourceCardId })
    const acknowledgement = personal.start(item)
    if (!acknowledgement) return false
    if (previous && previous.id !== item.id) personal.discard(previous.id)
    return sourceCardId ? acknowledgement : true
  }

  const selectionAction = (action: SelectionAction) => {
    if (!selection) return
    // 添加到对话: the selection becomes the composer's quote; the person writes the rest.
    if (action.key === ADD_TO_CHAT.key) { setQuote(quotable(selectionQuote(selection.selected, selection.text))); setSelection(null); return }
    void send(quotedMessage(selectionQuote(selection.selected, selection.text), action.instruction))
  }

  // 停止: the turn ends on the server, keeping what it had said. Stop is away only while its request is out; one that fails or
  // leaves the chat working 10 seconds later shows 「没停下 · 重试」.
  const stopper = useStop(() => agent.cancel(), agent.status === 'busy', reload)

  const reactions = data?.reactions ?? {}
  const reactionPending = useRef(new Map<string, object>())
  const [reactionFailure, setReactionFailure] = useState<{ id: string; emoji: string | null } | null>(null)
  useEffect(() => { reactionPending.current.clear(); setReactionFailure(null) }, [self, apiContext])
  // Optimistic feedback is rolled back if saving fails, even when the subsequent read is offline too.
  const react = async (id: string, emoji: string | null) => {
    if (reactionPending.current.has(id)) return
    const request = {}; reactionPending.current.set(id, request)
    const accept = (apply: () => void) => apiCache.commit(apiContext, () => { if (reactionPending.current.get(id) === request) apply() })
    const previous = reactions[id] ?? []
    setReactionFailure(null)
    setData(current => current && { ...current, reactions: { ...current.reactions, [id]: withMine(previous, emoji) } })
    try { await api('/api/mobile/reactions', { method: 'POST', body: { messageId: id, emoji } }) }
    catch {
      accept(() => {
        setData(current => current && { ...current, reactions: { ...current.reactions, [id]: previous } })
        setReactionFailure({ id, emoji })
      })
    } finally {
      if (reactionPending.current.get(id) === request) { reactionPending.current.delete(id); void reload() }
    }
  }

  // ⋯ under a message: reactions, then 回复 · 复制 · 选择文本 (MessageMenu).
  const message = (words: string, id?: string, key?: number): HeldMessage => ({ text: plainText(words), onQuote: () => setQuote(quotable(words)),
    ...(key !== undefined ? { onSelect: () => toggleSelection(key, words) } : {}),
    ...(id ? { react: { current: myReaction(reactions[id]), set: emoji => void react(id, emoji) } } : {}) })
  const chips = (id: string | undefined, align?: 'right') => id
    ? <Reactions reactions={reactions[id]} align={align} onToggle={emoji => void react(id, toggled(reactions[id], emoji))} />
    : null

  const renderItem = (item: Chat['items'][number], index: number) => {
    // A centred time above each group: the first message, one 15 minutes after the last, or one on a new day.
    const separator = startsGroup(item.createdAt, items[index - 1]?.createdAt) ? separatorLabel(item.createdAt) : null
    const cardDocument = generatedCardDocument(item)
    const question = item.from === 'event' ? questionCard(item.line, sources) : null
    const selected = selection?.key === item.position ? selection : null
    return (
      <Arrival animate={arrived(item.position)}>
        {separator ? <TimeSeparator label={separator} /> : null}
        {question ? <ThreadCard title={question.title} status="waiting" info="在等你回答" action="去回答" onPress={() => {
          // A question about a task's thread opens the task at that attempt (2026-11-07).
          const run = sources[question.runId]
          router.push(run?.kind === 'run' && run.issue ? `/task/${run.issue.id}?attempt=${question.runId}` : `/thread/${question.runId}`)
        }} />
          : item.from === 'event' ? <EventLine text={eventText(item.line, sources)} /> : null}
        {item.from === 'person' && (item.text || item.images) ? (
          <MessageRow align="right" onSelect={item.text && !selected ? () => toggleSelection(item.position, item.text) : undefined}>
            <MyBubble text={item.text} photos={photos(item.id, item.images)} selecting={selected ? <ChatSelectableText text={selected.text} color={colors.onAccent} onSelect={onSelected} onRect={rect => { selectionRect.current = rect }} /> : undefined} />
            {chips(item.id, 'right')}
          </MessageRow>
        ) : null}
        {item.from === 'coordinator' && item.text ? (
          <MessageRow onSelect={selected ? undefined : () => toggleSelection(item.position, item.text)}>
            {cardDocument
              ? <OpenUIReply text={item.text} live={index > lastMine} canAnswer={child => canAnswerCard(outbox, `${cardDocument}:${child}`)} reply={items.slice(index + 1).find(next => next.from === 'person')?.text} answer={(message, child) => send(message, [], `${cardDocument}:${child}`)} sources={sources} onOpen={open} />
              : <BotBubble>{selected
                ? <ChatSelectableText text={selected.text} onSelect={onSelected} onRect={rect => { selectionRect.current = rect }} />
                : <Markdown text={item.text} sources={sources} onOpen={open} />}</BotBubble>}
            {chips(item.id)}
            {selected ? null : <MessageActions message={message(item.text, item.id, item.position)} copy={index === latestReply && !working} />}
          </MessageRow>
        ) : null}
        {item.from === 'coordinator' && item.stopped ? <Text style={styles.stopped}>已停止</Text> : null}
        {item.threads.map(id => {
          const run = sources[id]
          if (run?.kind !== 'run') return null
          // A dispatch is its task's card (2026-11-07): the attempt's state icon, number and title, then state · bot · time.
          const result = run.issue ? attemptState({ group: run.group, status: run.status }) : null
          return (
            <View key={id}>
              {run.issue && result
                ? <ThreadCard title={[run.issue.identifier, run.issue.title].filter(Boolean).join(' ')} status={runIcon(run)} onPress={() => open(run)}
                  icon={<AttemptIcon result={result} />}
                  footer={run.issue.review ? <ReviewSummaryRow compact short summary={run.issue.review} onPress={() => router.push(reviewHref(run.issue!.id))} /> : undefined}
                  info={[ATTEMPT_WORD[result], run.agentName, shortWhen(item.createdAt)].filter(Boolean).join(' · ')} />
                : <ThreadCard title={runName(run)} status={runIcon(run)} info={runInfoLine(run.info)} onPress={() => open(run)} />}
            </View>
          )
        })}
      </Arrival>
    )
  }

  return (
    <View style={styles.screen}>
      {/* Back is the system's (and its edge swipe); the title pill opens the bot's page, ⋯ its tasks and its page. */}
      <ChatHeader scrolled={underBar.scrolled} name={name} color={color} shape={shape} botId={ownBotId} coordinator={self === 'coordinator'} tasks={tasks.data ? menuTasks(tasks.data.tasks, ownBotId) : null} onTask={id => router.push(`/task/${id}`)}
        onAllTasks={() => router.push(`/bots/${self}/tasks`)} onInfo={() => router.push(`/bots/${self}/info`)} />
      {/* The message list comes first, so the iOS bar finds it and blurs what scrolls under (scroll-edge effect). */}
      <View style={{ flex: 1, overflow: 'hidden' }}
        // While words are selected, a tap anywhere but on that message ends it; the touch still reaches what is there.
        onTouchStart={selection ? event => { touch.current = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY, at: Date.now() } } : undefined}
        onTouchEnd={selection ? event => {
          const down = touch.current; touch.current = null
          if (down && endsSelection(down, { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY, at: Date.now() }, selectionRect.current)) setSelection(null)
        } : undefined}>
        {/* The system scroll: momentum, and a bounce at both ends even while the chat is shorter than the screen. */}
        <ChatMessageList ref={list} testID="bot-chat-scroll" data={items} scrollEnabled onScrollUnderBar={underBar.onScroll} bottomInset={composerHeight} onAtLatestChange={setAtLatest}
          keyOf={item => generatedCardDocument(item) ?? item.streamId ?? (item.pending ? `pending-${item.position}` : String(item.position))} renderItem={renderItem} anchorIndex={anchorIndex}
          onStartReached={data?.historyBefore ? () => void loadOlder() : undefined}
          header={loadingOlder ? <View style={styles.older}><Spinner size={16} /></View> : null}
          footer={<>
        {outbox.map(item => item.phase === 'accepted'
          ? <MyBubble key={item.id} text={item.text} photos={item.images.map(image => ({ uri: image.uri }))} />
          : <OutgoingBubble key={item.id} text={item.text} photos={item.images.map(image => image.uri)} failed={item.phase === 'failed'} unconfirmed={item.error === mobileMessages.Coordinator.sendUncertain} error={item.error} onRetry={() => { void personal.start(item) }} />)}
        {working ? <WaitingLine since={outbox.length ? null : waitingSince(items)} /> : null}
        {stopper.stuck ? <StopFailed busy={stopper.sending} onRetry={() => void stopper.stop()} /> : null}
        {!data && !error ? <View style={styles.loading}><Spinner /></View> : null}
        {data && data.enabled !== false && !items.length && !outbox.length && !working ? <Text style={styles.empty}>有什么要我做的，直接说。</Text> : null}
        <ReadNotice error={error ?? agent.error} hasData={Boolean(data)} label={mobileMessages.Coordinator.conversation} onRetry={reload} />
        <ReadNotice error={pending.error} hasData={Boolean(pending.data)} label="待处理事项" onRetry={pending.reload} />
        {data?.failure && !working ? <FailedReply key={`${botId}:${JSON.stringify(data.failure)}`} failure={data.failure} botId={botId} onQueued={reload} modelChoice={typeof composerAccessory === 'function' ? composerAccessory(false) : composerAccessory} /> : null}
        {pending.data ? <PendingActions items={pending.data} focus={focus} reload={pending.reload} onFocusLayout={focus ? showFocus : undefined} /> : null}
          </>} />
        <ListTopFade color={colors.page} />
      </View>
      <ChatScrollToLatest visible={!atLatest} bottom={composerHeight + 12} onPress={() => list.current?.toLatest()} />
      <OfflineBanner top={insets.top + 66} />
      <Composer value={text} sendDisabled={serviceUnavailable || agent.status === 'resuming'} onChangeText={setText} placeholder={selection ? mobileMessages.MobileCore.replySelection : name ? mobileMessages.Nav.messageBot.replace('{name}', name) : mobileMessages.MobileCore.message} onSend={send} attach attachmentScope={data?.botId ? { kind: 'bot', id: data.botId } : botId ? { kind: 'bot', id: botId } : undefined} overlay onHeight={setComposerHeight} autoFocus={compose || Boolean(draft)}
        quote={quote} onClearQuote={() => setQuote(null)} accessory={typeof composerAccessory === 'function' ? composerAccessory(working) : composerAccessory} notice={<>{serviceUnavailable ? <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.serviceNotice}><Text style={styles.serviceMessage}>对话服务尚未启用，暂时无法回复。</Text><GlassButton label="重试" busy={serviceRefresh.refreshing} onPress={() => void serviceRefresh.onRefresh()} /></View> : null}{composerNotice}<EveInteractions agent={agent} />{reactionFailure ? <View accessibilityRole="alert" style={styles.reactionNotice}><Text style={styles.error}>回应没保存。</Text><GlassButton label="重试" onPress={() => void react(reactionFailure.id, reactionFailure.emoji)} /></View> : null}
          <ChatQueueCard items={queue} busy={stopper.sending} onSendNow={agent.status === 'busy' ? () => void stopper.stop() : undefined} />
          <ChatSelectionBar visible={Boolean(selection)} disabled={serviceUnavailable} onAction={selectionAction} /></>} onStop={(agent.status === 'busy' || activeTurn(agent.view) !== undefined) && agent.status !== 'resuming' && !stopper.sending ? () => void stopper.stop() : undefined} />
    </View>
  )
}

/** When the person's unanswered message was sent; a reply is counted from there. Otherwise (an event woke the bot) from when the screen saw it start. */
function waitingSince(items: Chat['items']) {
  const last = [...items].reverse().find(item => item.from !== 'event')
  const at = last?.from === 'person' ? Date.parse(last.createdAt) : NaN
  return Number.isFinite(at) ? at : null
}

/** The reply on its way: the spinner, and after 30 seconds what it waits for and for how long (Figma 843:2 #1). */
function WaitingLine({ since }: { since: number | null }) {
  const [start] = useState(() => since ?? Date.now())
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const label = waitingLabel(Math.min(since ?? start, now), now)
  return (
    <View style={[styles.working, label ? styles.waiting : null]}>
      <Spinner size={16} />
      {label ? <Text style={styles.waitingText}>{label}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  serviceNotice: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, marginBottom: 8 },
  serviceMessage: { flex: 1, fontSize: 13, lineHeight: 18, color: colors.secondary },
  reactionNotice: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, gap: 8 },
  screen: { flex: 1, backgroundColor: colors.page },
  // Space above the composer (适度留白).
  older: { paddingVertical: 12, alignItems: 'center' },
  loading: { paddingTop: 120, alignItems: 'center' },
  stopped: { alignSelf: 'flex-start', fontSize: 12, lineHeight: 17, color: colors.secondary, marginLeft: 4, marginTop: -6 },
  working: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.bubble, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 12 },
  waiting: { paddingLeft: 14, paddingVertical: 10 },
  waitingText: { fontSize: 14, lineHeight: 20, color: colors.secondary },
  failed: { alignItems: 'center', gap: 10, marginTop: 24 },
  empty: { alignSelf: 'center', color: colors.secondary, marginTop: 40, fontSize: 15 },
  error: { alignSelf: 'center', color: colors.danger, fontSize: 13, textAlign: 'center', marginHorizontal: 24 },
})

/** The native eve binding must never survive a Bot, account or Workspace switch. */
export function ChatScreen(props: Parameters<typeof ChatScreenSession>[0]) {
  const workspaceId = useHome().data?.live?.workspaceId
  return <ChatScreenSession key={`${apiCache.context()}:${workspaceId ?? ''}:${props.botId ?? 'coordinator'}`} {...props} />
}
