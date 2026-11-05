import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, View, type ScrollViewInstance } from 'react-native'
import { ChatScrollView } from '@/components/ChatScrollView'
import { GestureDetector } from 'react-native-gesture-handler'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ellipsis } from 'lucide-react-native'
import { uuid } from 'expo'
import { Spinner } from '@/components/icons'
import { runIcon } from '@/lib/thread-icon'
import { Arrival, BotBubble, EventLine, MyBubble, OutgoingBubble, Reactions, ReplyActions, ThreadCard, TimedRow, useChatPhotos, useTimeReveal } from '@/components/chat'
import { myReaction, toggled, withMine } from '@/lib/reactions'
import { Markdown } from '@/components/Markdown'
import { OfflineBanner } from '@/components/OfflineBanner'
import { OpenUIReply } from '@/components/OpenUI'
import { PendingActions } from '@/components/PendingActions'
import { Text } from '@/components/Text'
import { NavBar, underBar } from '@/components/NavBar'
import { Capsule, Composer } from '@/components/ui'
import { GlassButton } from '@/components/GlassButton'
import { api } from '@/lib/api'
import { outgoing, type Attachment } from '@/lib/attachments'
import { clockTime } from '@/lib/clock'
import { isOpenUI } from '@/lib/openui'
import { holdMessage, type HeldMessage } from '@/lib/message-actions'
import { plainText, quotable } from '@/lib/quote'
import { delivered, inFlight, marked, outgoingKey, queued, sendFailureState, submissionBody, unsettled, type Outgoing } from '@/lib/outbox'
import { apiCache } from '@/lib/api-cache'
import { askForPush, usePushState } from '@/lib/push-state'
import { runName, type Chat, type CitationSource, type PendingAction } from '@/lib/types'
import { FailedReply } from '@/components/FailedReply'
import { eventText, questionCard } from '@/lib/event-line'
import { waitingLabel } from '@/lib/waiting'
import { useLiveApi, useRefresh } from '@/lib/useApi'
import { listRef, UNRESOLVED_LIVE_ID } from '@/lib/live'
import { pendingActionsDeadline } from '@/lib/live-client'
import { useStop } from '@/lib/useStop'
import { StopFailed } from '@/components/StopFailed'
import { ReadNotice } from '@/components/ReadNotice'
import { ChatScrollToLatest } from '@/components/ChatScrollToLatest'
import { useChatScroll } from '@/lib/useChatScroll'
import { useReducedMotionPreference } from '@/lib/reduced-motion'
import { runInfoLine } from '@/lib/run-info'
import { webChatPath } from '@/lib/web'
import { useHome } from '@/lib/home'
import { colors } from '@/lib/theme'

/**
 * A chat with a bot; the Coordinator is one (R-06): the bot's name in a pill,
 * the threads behind the right button, the composer at the bottom. Reads again
 * when the server pushes the chat's key (a message, a turn, a run it cites). Below the messages sit the proposals waiting for the
 * person (approve or decline, as on the web); `focus` marks the one a push
 * was about. OpenUI cards are drawn natively (components/OpenUI.tsx).
 */
export function ChatScreen({ botId, name, draft, focus, compose, composerAccessory, composerNotice }: { botId: string | null; name: string; color?: string; shape?: string; draft?: string; focus?: string; compose?: boolean; composerAccessory?: ReactNode | ((running: boolean) => ReactNode); composerNotice?: ReactNode }) {
  const [quote, setQuote] = useState<string | null>(null)
  const self = botId ?? 'coordinator'
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const scroll = useRef<ScrollViewInstance>(null)
  const { offset, gesture: timeReveal, scrollLocked } = useTimeReveal()
  const photos = useChatPhotos()
  const workspaceId = useHome().data?.workspace.id
  // The composer floats over the end of the list; the list leaves room for it.
  const [composerHeight, setComposerHeight] = useState(90)
  const path = `/api/mobile/chat${botId ? `?bot=${botId}` : ''}`
  const home = useHome().data?.live?.workspaceId
  // The web's chat key (components/coordinator/coordinator-chat.tsx) on the person's home channel; a turn's lease
  // running out has no write, so the server names it as a deadline.
  const { data, error, reload, setData } = useLiveApi<Chat>(path, chat => ({
    refs: [{ kind: 'bot_chat', id: chat?.botId && chat.live?.workspaceId ? chat.botId : UNRESOLVED_LIVE_ID, scope: chat?.live?.workspaceId ?? null }],
    minIntervalMs: 2_000, deadline: chat?.live?.deadline,
  }))
  const serviceUnavailable = data?.enabled === false
  const serviceRefresh = useRefresh(reload)
  // The person's proposals: the web's key (components/coordinator/pending-actions.tsx), on the same home channel.
  const pending = useLiveApi<PendingAction[]>('/api/pending-actions', items => ({
    refs: [listRef('pending_actions', home)], deadline: pendingActionsDeadline(items),
  }))
  const [outbox, setOutbox] = useState<Outgoing[]>([])
  const pendingSends = useRef<Outgoing[]>([])
  const delivering = useRef(new Map<string, Promise<boolean>>())
  const apiContext = apiCache.context()
  const updateOutbox = (change: (list: Outgoing[]) => Outgoing[]) => {
    pendingSends.current = change(pendingSends.current)
    setOutbox(pendingSends.current)
  }
  useEffect(() => { pendingSends.current = []; setOutbox([]) }, [botId, apiContext])
  const [text, setText] = useState(draft ?? '')
  const working = Boolean(data?.working) || inFlight(outbox)
  const push = usePushState()
  // Opened from a push about a proposal: its card is scrolled into view once, instead of the chat's end.
  const pendingTop = useRef(0)
  const [pinned, setPinned] = useState(false)
  const chatScroll = useChatScroll(scroll, `${self}:${apiContext}`, pinned)
  const reduceMotion = useReducedMotionPreference()
  const showFocus = (y: number) => {
    if (pinned) return
    setPinned(true)
    chatScroll.pause()
    // After this frame's layout, so the list's own offset (measured after its children) is known.
    setTimeout(() => scroll.current?.scrollTo({ y: Math.max(0, pendingTop.current + y - insets.top - 84), animated: !reduceMotion }), 0)
  }
  useEffect(() => { setPinned(false) }, [focus])

  useEffect(() => { if (draft) setText(draft) }, [draft])

  const items = data?.items ?? []
  const sources = data?.sources ?? {}
  // What the chat held when it opened just appears; anything after it rises in (Arrival).
  const opened = useRef<{ chat: string; last: number } | null>(null)
  const chatKey = `${self}:${apiContext}`
  if (data && opened.current?.chat !== chatKey) opened.current = { chat: chatKey, last: items.reduce((last, item) => Math.max(last, item.position), -1) }
  const arrived = (position: number) => Boolean(opened.current && position > opened.current.last)
  // The one action row goes under the bot's latest reply, once it has finished (#1386).
  const latestReply = items.reduce((last, item, index) => item.from === 'coordinator' && item.text ? index : item.from === 'person' ? -1 : last, -1)
  // A card is answered once the person has written after it (here or anywhere else).
  const lastMine = items.reduce((last, item, index) => item.from === 'person' ? index : last, -1)
  const proactive = items.some((item, index) => item.from === 'coordinator' && items[index - 1]?.from === 'event')

  // iOS asks once; the moment is the first message the Coordinator sent on its own, not app launch.
  useEffect(() => { if (proactive && push === 'undetermined') void askForPush() }, [proactive, push])

  const open = (source: CitationSource) => {
    if (source.kind === 'run') router.push(`/thread/${source.id}`)
    else router.push('/tasks')
  }

  const deliver = (item: Outgoing): Promise<boolean> => {
    const active = delivering.current.get(item.submissionId)
    if (active) return active
    const request = (async () => {
      if (item.context !== apiCache.context()) return false
      try {
        const receipt = await api<{ queued?: boolean }>('/api/mobile/chat', { method: 'POST', body: submissionBody(item) })
        if (receipt?.queued !== true) throw new Error('sendUnconfirmed')
        await reload()
        return apiCache.commit(item.context, () => updateOutbox(list => delivered(list, item.key)))
      } catch (error) {
        apiCache.commit(item.context, () => updateOutbox(list => marked(list, item.key, sendFailureState(error))))
        return false
      }
    })().finally(() => { delivering.current.delete(item.submissionId) })
    delivering.current.set(item.submissionId, request)
    return request
  }

  const send = async (words: string, attachments: Attachment[] = []) => {
    if (serviceUnavailable) return false
    setPinned(false)
    chatScroll.toLatest()
    const { text: message, images } = outgoing(words, attachments)
    const context = apiCache.context()
    const targetBotId = data?.botId ?? botId
    const held = unsettled(pendingSends.current, message, images, self, context)
    const item = held ?? queued([], outgoingKey(uuid.v4), message, images, { botId: targetBotId, chatKey: self, context })[0]
    updateOutbox(list => held ? marked(list, item.key, 'sending') : [...list, item])
    return deliver(item)
  }

  const retry = async (item: Outgoing) => {
    updateOutbox(list => marked(list, item.key, 'sending'))
    // The composer still holds the words of a failed send; once they arrive it empties.
    if (await deliver(item)) setText(current => current.trim() === item.text ? '' : current)
  }

  const answer = async (message: string) => send(message)

  // 停止: the turn ends on the server, keeping what it had said. Stop is away only while its request is out; one that fails or
  // leaves the chat working 10 seconds later shows 「没停下 · 重试」.
  const stopper = useStop(() => api('/api/mobile/chat/stop', { method: 'POST', body: { botId } }), Boolean(data?.working), reload)

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

  // A long press: reactions, then 回复 · 复制 · 选择文本 in a system sheet (app/message.tsx).
  const message = (words: string, id?: string): HeldMessage => ({ text: plainText(words), onQuote: () => setQuote(quotable(words)),
    ...(id ? { react: { current: myReaction(reactions[id]), set: emoji => void react(id, emoji) } } : {}) })
  const actions = (words: string, id?: string) => {
    holdMessage(message(words, id))
    router.push('/message')
  }
  const chips = (id: string | undefined, align?: 'right') => id
    ? <Reactions reactions={reactions[id]} align={align} onToggle={emoji => void react(id, toggled(reactions[id], emoji))} />
    : null

  return (
    <View style={styles.screen}>
      {/* Back is the system's (and its edge swipe); the bot's name opens the bot's page. */}
      <NavBar material
        titleView={
          <Pressable accessibilityRole="button" accessibilityLabel={name ? `${name} 的资料` : '资料'} onPress={() => router.push(`/bots/${self}/info`)}>
            {/* The name alone, as Messages and ChatGPT title a chat; the bot's mark is on its page (#1386). */}
            <Capsule>
              {/* The bot's name is not in yet (opened from a push before 对话 loaded): a spinner, never an empty pill. */}
              {name ? <Text style={styles.titleText} numberOfLines={1}>{name}</Text> : <Spinner size={14} />}
            </Capsule>
          </Pressable>
        }
        right={{ icon: 'ellipsis', label: '更多', web: <Ellipsis size={21} color={colors.ink} strokeWidth={2} />, onOpen: () => router.push(`/bots/${self}/info`),
          items: [
            { label: '资料', icon: 'person.crop.circle', onPress: () => router.push(`/bots/${self}/info`) },
            { label: '线程', icon: 'checklist', onPress: () => router.push(`/bots/${self}/threads`) },
          ] }}
      />
      {/* The message list comes first, so the iOS bar finds it and blurs what scrolls under (scroll-edge effect). */}
      <GestureDetector gesture={timeReveal}>
      <View style={{ flex: 1, overflow: 'hidden' }}>
        {/* The system scroll: momentum, and a bounce at both ends even while the chat is shorter than the screen. */}
        <ChatScrollView scrollEnabled={!scrollLocked} ref={scroll} testID="bot-chat-scroll" bounces alwaysBounceVertical {...underBar} offset={Math.max(insets.bottom, 12) - 8} keyboardDismissMode="interactive" keyboardLiftBehavior="whenAtEnd" contentContainerStyle={[styles.list, { paddingBottom: composerHeight + 16 }]} onScroll={event => { if (chatScroll.onScroll(event)) setPinned(false) }} scrollEventThrottle={16} onContentSizeChange={chatScroll.onContentSizeChange}>
          {items.map((item, index) => {
            const time = clockTime(item.createdAt)
            const question = item.from === 'event' ? questionCard(item.line, sources) : null
            return (
              <Arrival key={item.pending ? `pending-${item.position}` : item.position} animate={arrived(item.position)}>
                {question ? <ThreadCard title={question.title} status="waiting" info="在等你回答" action="去回答" onPress={() => router.push(`/thread/${question.runId}`)} />
                  : item.from === 'event' ? <EventLine text={eventText(item.line, sources)} /> : null}
                {item.from === 'person' && (item.text || item.images) ? <TimedRow time={time} offset={offset} align="right" onQuote={item.text ? () => setQuote(quotable(item.text)) : undefined} onLongPress={item.text ? () => actions(item.text, item.id) : undefined} menu={item.text ? message(item.text, item.id) : undefined}><MyBubble text={item.text} photos={photos(item.id, item.images)} />{chips(item.id, 'right')}</TimedRow> : null}
                {item.from === 'coordinator' && item.text ? (
                  <TimedRow time={time} offset={offset} onQuote={() => setQuote(quotable(item.text))} onLongPress={() => actions(item.text, item.id)} menu={message(item.text, item.id)}>
                    {isOpenUI(item.text)
                      ? <OpenUIReply text={item.text} live={index > lastMine && !outbox.length} reply={items.slice(index + 1).find(next => next.from === 'person')?.text} answer={answer} webPath={webChatPath(data?.botId ?? botId, workspaceId)} sources={sources} onOpen={open} />
                      : <BotBubble><Markdown text={item.text} sources={sources} onOpen={open} /></BotBubble>}
                    {chips(item.id)}
                    {index === latestReply && !working ? <ReplyActions text={plainText(item.text)} onQuote={() => setQuote(quotable(item.text))} onMore={() => actions(item.text, item.id)} /> : null}
                  </TimedRow>
                ) : null}
                {item.from === 'coordinator' && item.stopped ? <Text style={styles.stopped}>已停止</Text> : null}
                {item.threads.map(id => {
                  const run = sources[id]
                  return run?.kind === 'run'
                    ? <TimedRow key={id} time={time} offset={offset}><ThreadCard title={runName(run)} status={runIcon(run)} info={runInfoLine(run.info)} onPress={() => router.push(`/thread/${id}`)} /></TimedRow>
                    : null
                })}
              </Arrival>
            )
          })}
          {outbox.map(item => <OutgoingBubble key={item.key} text={item.text} photos={item.images.map(image => image.uri)} failed={item.state !== 'sending'} unconfirmed={item.state === 'unconfirmed'} onRetry={() => void retry(item)} />)}
          {working ? <WaitingLine since={outbox.length ? null : waitingSince(items)} /> : null}
          {stopper.stuck ? <StopFailed busy={stopper.sending} onRetry={() => void stopper.stop()} /> : null}
          {!data && !error ? <View style={styles.loading}><Spinner /></View> : null}
          {data && data.enabled !== false && !items.length && !working ? <Text style={styles.empty}>有什么要我做的，直接说。</Text> : null}
          <ReadNotice error={error} hasData={Boolean(data)} label="对话" onRetry={reload} />
          <ReadNotice error={pending.error} hasData={Boolean(pending.data)} label="待处理事项" onRetry={pending.reload} />
          {data?.failure && !working ? <FailedReply key={`${botId}:${JSON.stringify(data.failure)}`} failure={data.failure} botId={botId} onQueued={reload} modelChoice={typeof composerAccessory === 'function' ? composerAccessory(false) : composerAccessory} /> : null}
          {pending.data ? (
            <View onLayout={event => { pendingTop.current = event.nativeEvent.layout.y }}>
              <PendingActions items={pending.data} focus={focus} reload={pending.reload} onFocusLayout={focus ? showFocus : undefined} />
            </View>
          ) : null}
        </ChatScrollView>
      </View>
      </GestureDetector>
      <ChatScrollToLatest visible={!chatScroll.atEnd} bottom={composerHeight + 12} onPress={() => { setPinned(false); chatScroll.toLatest() }} />
      <OfflineBanner top={insets.top + 66} />
      <Composer value={text} sendDisabled={serviceUnavailable} onChangeText={setText} placeholder={name ? `给 ${name} 发消息` : '发消息'} onSend={send} attach attachmentScope={data?.botId ? { kind: 'bot', id: data.botId } : botId ? { kind: 'bot', id: botId } : undefined} overlay onHeight={setComposerHeight} autoFocus={compose || Boolean(draft)}
        quote={quote} onClearQuote={() => setQuote(null)} accessory={typeof composerAccessory === 'function' ? composerAccessory(working) : composerAccessory} notice={<>{serviceUnavailable ? <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.serviceNotice}><Text style={styles.serviceMessage}>对话服务尚未启用，暂时无法回复。</Text><GlassButton label="重试" busy={serviceRefresh.refreshing} onPress={() => void serviceRefresh.onRefresh()} /></View> : null}{composerNotice}{reactionFailure ? <View accessibilityRole="alert" style={styles.reactionNotice}><Text style={styles.error}>回应没保存。</Text><GlassButton label="重试" onPress={() => void react(reactionFailure.id, reactionFailure.emoji)} /></View> : null}</>} onStop={Boolean(data?.working) && !stopper.sending ? () => void stopper.stop() : undefined} />
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
  titleText: { fontSize: 17, fontWeight: '600' },
  // Space above the composer (适度留白).
  list: { paddingHorizontal: 16, gap: 12 },
  loading: { paddingTop: 120, alignItems: 'center' },
  stopped: { alignSelf: 'flex-start', fontSize: 12, lineHeight: 17, color: colors.secondary, marginLeft: 4, marginTop: -6 },
  working: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.bubble, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 12 },
  waiting: { paddingLeft: 14, paddingVertical: 10 },
  waitingText: { fontSize: 14, lineHeight: 20, color: colors.secondary },
  failed: { alignItems: 'center', gap: 10, marginTop: 24 },
  empty: { alignSelf: 'center', color: colors.secondary, marginTop: 40, fontSize: 15 },
  error: { alignSelf: 'center', color: colors.danger, fontSize: 13, textAlign: 'center', marginHorizontal: 24 },
})
