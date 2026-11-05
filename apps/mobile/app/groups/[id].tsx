import { useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet, View, type ScrollViewInstance } from 'react-native'
import { ChatScrollView } from '@/components/ChatScrollView'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { BotAvatar, Spinner } from '@/components/icons'
import { BotBubble, CopyButton, MyBubble, Reactions, TimedRow, useTimeReveal } from '@/components/chat'
import { Markdown } from '@/components/Markdown'
import { NavBar, underBar } from '@/components/NavBar'
import { Text } from '@/components/Text'
import { Composer } from '@/components/ui'
import { CardButton } from '@/components/cards'
import { ReadNotice } from '@/components/ReadNotice'
import { OfflineBanner } from '@/components/OfflineBanner'
import { StopFailed } from '@/components/StopFailed'
import { ChatScrollToLatest } from '@/components/ChatScrollToLatest'
import { apiCache } from '@/lib/api-cache'
import { groupReactionPaths, mergeGroupMessages } from '@/lib/group-history'
import { useChatScroll } from '@/lib/useChatScroll'
import { api } from '@/lib/api'
import { clockTime } from '@/lib/clock'
import { mentionsIn } from '@/lib/group'
import { useHome } from '@/lib/home'
import { holdMessage } from '@/lib/message-actions'
import { plainText, quotable } from '@/lib/quote'
import { myReaction, toggled, withMine } from '@/lib/reactions'
import type { GroupMember, GroupMessage, GroupPage, GroupSummary, Reaction } from '@/lib/types'
import { useApi } from '@/lib/useApi'
import { colors } from '@/lib/theme'

/**
 * A group chat: the person and their bots in one conversation. A message goes
 * to the bots it @mentions, else to the ones Mikka judges should answer. The
 * person's messages sit on the right in blue; each bot's on the left under its
 * name and avatar, as in a messaging app's group.
 */
export default function GroupChat() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const home = useHome()
  const me = home.data?.user.id
  const scroll = useRef<ScrollViewInstance>(null)
  const { offset, handlers } = useTimeReveal()
  const apiContext = apiCache.context()
  const chatScroll = useChatScroll(scroll, `${id}:${apiContext}`)
  const [composerHeight, setComposerHeight] = useState(90)
  const [text, setText] = useState('')
  const [quote, setQuote] = useState<string | null>(null)
  const [sendFailed, setSendFailed] = useState(false)
  const groups = useApi<{ conversations: GroupSummary[] }>(home.data ? `/api/conversations?workspaceId=${home.data.workspace.id}` : null)
  const title = groups.data?.conversations.find(group => group.id === id)?.title ?? ''
  const [fast, setFast] = useState(false)
  const page = useApi<GroupPage>(`/api/conversations/${id}/messages?limit=100`, fast ? 2500 : 8000)
  const members = useApi<{ members: GroupMember[] }>(`/api/conversations/${id}/members`, 60_000)
  const [history, setHistory] = useState<{ identity: string; messages: GroupMessage[]; before: string | null } | null>(null)
  const identity = `${id}:${apiContext}`
  const currentHistory = history?.identity === identity ? history : null
  const messages = mergeGroupMessages(currentHistory?.messages ?? [], page.data?.messages ?? [])
  const before = currentHistory ? currentHistory.before : page.data?.nextBefore
  const [historyError, setHistoryError] = useState<unknown>(null)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const historyRequest = useRef<object | null>(null)
  useEffect(() => { historyRequest.current = null; setLoadingHistory(false); setHistoryError(null) }, [identity])
  useEffect(() => {
    if (!page.data) return
    setHistory(current => current?.identity === identity
      ? { ...current, messages: mergeGroupMessages(current.messages, page.data!.messages) }
      : { identity, messages: mergeGroupMessages([], page.data!.messages), before: page.data!.nextBefore })
  }, [identity, page.data])
  const loadEarlier = async () => {
    if (!before || historyRequest.current) return
    const request = {}; historyRequest.current = request
    setLoadingHistory(true); setHistoryError(null)
    try {
      const earlier = await api<GroupPage>(`/api/conversations/${id}/messages?limit=100&before=${encodeURIComponent(before)}`)
      apiCache.commit(apiContext, () => {
        if (historyRequest.current !== request) return
        chatScroll.preservePrepend()
        setHistory(current => ({ identity, before: earlier.nextBefore, messages: mergeGroupMessages(current?.identity === identity ? current.messages : messages, earlier.messages) }))
      })
    } catch (error) {
      apiCache.commit(apiContext, () => { if (historyRequest.current === request) setHistoryError(error) })
    } finally {
      if (historyRequest.current === request) { historyRequest.current = null; setLoadingHistory(false) }
    }
  }
  const ids = messages.map(message => message.id).join(',')
  const readReactions = useCallback(async () => {
    const pages = await Promise.all(groupReactionPaths(ids.split(',').filter(Boolean)).map(path => api<{ reactions: Record<string, Reaction[]> }>(path)))
    return { reactions: Object.assign({}, ...pages.map(page => page.reactions)) as Record<string, Reaction[]> }
  }, [ids])
  const reactionState = useApi<{ reactions: Record<string, Reaction[]> }>(ids ? `/api/mobile/reactions?ids=${ids}` : null, 15_000, readReactions)
  const [reactionSnapshot, setReactionSnapshot] = useState<{ identity: string; reactions: Record<string, Reaction[]> } | null>(null)
  useEffect(() => { if (reactionState.data) setReactionSnapshot({ identity, reactions: reactionState.data.reactions }) }, [identity, reactionState.data])
  const reactions = reactionState.data?.reactions ?? (reactionSnapshot?.identity === identity ? reactionSnapshot.reactions : {})
  const reactionPending = useRef(new Map<string, object>())
  const [reactionFailure, setReactionFailure] = useState<{ id: string; emoji: string | null } | null>(null)
  useEffect(() => { reactionPending.current.clear(); setReactionFailure(null) }, [identity])
  const working = Boolean(page.data?.agentStatus)
  useEffect(() => { setFast(working) }, [working])
  // 停止: the group's reply ends on the server; stop stays away until the group stops answering.
  const [stopping, setStopping] = useState(false)
  const [stopFailed, setStopFailed] = useState(false)
  const stopPending = useRef(false)
  useEffect(() => { if (!working) setStopping(false) }, [working])
  const stop = async () => {
    if (stopPending.current) return
    stopPending.current = true; setStopping(true); setStopFailed(false)
    try { await api(`/api/conversations/${id}/stop`, { method: 'POST' }); await page.reload() }
    catch { setStopping(false); setStopFailed(true) }
    finally { stopPending.current = false }
  }

  // What the person has seen: the newest message, once it is on screen.
  const newest = page.data?.messages[0]?.id
  useEffect(() => { if (newest && chatScroll.atEnd) void api(`/api/conversations/${id}/read`, { method: 'POST', body: { messageId: newest } }).catch(() => undefined) }, [id, newest, chatScroll.atEnd])

  const member = (type: string, memberId: string) => members.data?.members.find(item => item.memberType === type && item.id === memberId)
  const bots = (members.data?.members ?? []).filter(item => item.memberType !== 'user')

  // The composer has put the quote ahead of the words and clears both once this returns true.
  const send = async (body: string) => {
    setSendFailed(false)
    chatScroll.toLatest()
    try {
      await api(`/api/conversations/${id}/messages`, { method: 'POST', body: { body, mentions: mentionsIn(body, bots) } })
      await page.reload()
      return true
    } catch {
      setSendFailed(true)
      return false
    }
  }

  const react = async (messageId: string, emoji: string | null) => {
    if (reactionPending.current.has(messageId)) return
    const request = {}; reactionPending.current.set(messageId, request)
    const accept = (apply: () => void) => apiCache.commit(apiContext, () => { if (reactionPending.current.get(messageId) === request) apply() })
    const previous = reactions[messageId] ?? []
    setReactionFailure(null)
    reactionState.setData(current => ({ reactions: { ...reactions, ...current?.reactions, [messageId]: withMine(previous, emoji) } }))
    try { await api('/api/mobile/reactions', { method: 'POST', body: { messageId, emoji } }) }
    catch {
      accept(() => {
        reactionState.setData(current => ({ reactions: { ...current?.reactions, [messageId]: previous } }))
        setReactionFailure({ id: messageId, emoji })
      })
    } finally {
      if (reactionPending.current.get(messageId) === request) { reactionPending.current.delete(messageId); void reactionState.reload() }
    }
  }

  const actions = (words: string, messageId: string) => {
    holdMessage({ text: plainText(words), onQuote: () => setQuote(quotable(words)), react: { current: myReaction(reactions[messageId]), set: emoji => void react(messageId, emoji) } })
    router.push('/message')
  }
  const chips = (messageId: string, align?: 'right') => <Reactions reactions={reactions[messageId]} align={align} onToggle={emoji => void react(messageId, toggled(reactions[messageId], emoji))} />

  return (
    <View style={styles.screen}>
      <NavBar title={title} material />
      <View style={{ flex: 1, overflow: 'hidden' }} {...handlers}>
        <ChatScrollView ref={scroll} testID="group-chat-scroll" {...underBar} offset={Math.max(insets.bottom, 12) - 8} keyboardDismissMode="interactive" keyboardLiftBehavior="whenAtEnd"
          contentContainerStyle={[styles.list, { paddingBottom: composerHeight + 16 }]} onScroll={chatScroll.onScroll} scrollEventThrottle={16} onContentSizeChange={chatScroll.onContentSizeChange}>
          {!page.data && !page.error ? <View style={styles.loading}><Spinner /></View> : null}
          <ReadNotice error={page.error} hasData={Boolean(page.data)} label="群聊" onRetry={page.reload} />
          <ReadNotice error={reactionState.error} hasData={reactionSnapshot?.identity === identity} label="回应" onRetry={reactionState.reload} />
          <ReadNotice error={members.error} hasData={Boolean(members.data)} label="群成员" onRetry={members.reload} />
          {before ? <View style={styles.history}><CardButton label="加载更早消息" busy={loadingHistory} onPress={() => void loadEarlier()} /></View> : null}
          <ReadNotice error={historyError} label="更早消息" onRetry={loadEarlier} />
          {messages.map((message, index) => {
            const time = clockTime(message.createdAt)
            if (message.authorType === 'user' && message.authorId === me) {
              return (
                <TimedRow key={message.id} time={time} offset={offset} align="right" onQuote={() => setQuote(quotable(message.body))} onLongPress={() => actions(message.body, message.id)}>
                  <MyBubble text={message.body} />{chips(message.id, 'right')}
                </TimedRow>
              )
            }
            const author = member(message.authorType, message.authorId)
            const previous = messages[index - 1]
            const first = !previous || previous.authorType !== message.authorType || previous.authorId !== message.authorId
            return (
              <TimedRow key={message.id} time={time} offset={offset} onQuote={() => setQuote(quotable(message.body))} onLongPress={() => actions(message.body, message.id)}>
                {first ? (
                  <View style={styles.author}>
                    {message.authorType === 'user' ? null : <BotAvatar color={author?.color} shape={author?.shape} size={20} />}
                    <Text style={styles.authorName}>{author?.name ?? (message.authorType === 'user' ? '成员' : 'Bot')}</Text>
                  </View>
                ) : null}
                <BotBubble><Markdown text={message.body} /></BotBubble>
                {chips(message.id)}
                {message.authorType === 'user' ? null : <CopyButton text={plainText(message.body)} />}
              </TimedRow>
            )
          })}
          {working ? <View style={styles.working}><Spinner size={16} /></View> : null}
          {page.data && !messages.length ? <Text style={styles.empty}>@ 一个 Bot，或直接说</Text> : null}
          {page.data?.routingError && !working ? <Text style={styles.error}>没有 Bot 接这条，@ 它的名字</Text> : null}
          {page.data?.stopped && !working ? <Text style={styles.stopped}>已停止</Text> : null}
          {sendFailed ? <Text accessibilityRole="alert" style={styles.error}>没发出去，消息仍在输入框中。</Text> : null}
          {stopFailed ? <StopFailed busy={stopping} onRetry={() => void stop()} /> : null}
        </ChatScrollView>
      </View>
      <ChatScrollToLatest visible={!chatScroll.atEnd} bottom={composerHeight + 8} onPress={chatScroll.toLatest} />
      <OfflineBanner top={insets.top + 66} />
      <Composer value={text} onChangeText={setText} placeholder={`发到 ${title || '群聊'}`} onSend={words => send(words)} attach attachmentScope={{ kind: 'group', id }} overlay onHeight={setComposerHeight}
        notice={reactionFailure ? <View accessibilityRole="alert" style={styles.reactionNotice}><Text style={styles.error}>回应没保存。</Text><CardButton label="重试" onPress={() => void react(reactionFailure.id, reactionFailure.emoji)} /></View> : undefined}
        quote={quote} onClearQuote={() => setQuote(null)} onStop={working && !stopping ? () => void stop() : undefined} />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  list: { paddingHorizontal: 16, gap: 12 },
  reactionNotice: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, gap: 8 },
  history: { alignItems: 'center', paddingVertical: 8 },
  loading: { paddingTop: 120, alignItems: 'center' },
  author: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  authorName: { fontSize: 13, color: colors.secondary },
  working: { alignSelf: 'flex-start', backgroundColor: colors.bubble, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 12 },
  empty: { alignSelf: 'center', color: colors.secondary, marginTop: 40, fontSize: 15 },
  stopped: { alignSelf: 'center', color: colors.secondary, fontSize: 12 },
  error: { alignSelf: 'center', color: colors.danger, fontSize: 13, textAlign: 'center', marginHorizontal: 24 },
})
