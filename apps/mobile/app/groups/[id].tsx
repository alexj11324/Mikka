import { conversationAccessDenied, useConversationDelivery } from '@/features/chat/components/conversation-delivery'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { ChatMessageList, type ChatListHandle } from '@/features/chat/components/chat-message-list'
import { groupPagePath, mergeGroupHistory, mergeGroupRead, type GroupRead } from '@/features/chat/model/chat-pages'
import { latestOwnIndex } from '@/features/chat/model/chat-layout'
import { useReducedMotionPreference } from '@/lib/reduced-motion'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { BotAvatar, Spinner } from '@/components/icons'
import { BotBubble, MessageActions, MessageRow, MyBubble, Reactions, TimeSeparator } from '@/components/chat'
import { Markdown } from '@/components/Markdown'
import { ListTopFade, NavBar } from '@/components/NavBar'
import { useScrolledUnderBar } from '@/components/BarBackdrop'
import { Text } from '@/components/Text'
import { Composer } from '@/features/chat/components/chat-composer'
import { GlassButton } from '@/components/GlassButton'
import { ReadNotice } from '@/components/ReadNotice'
import { OfflineBanner } from '@/components/OfflineBanner'
import { StopFailed } from '@/components/StopFailed'
import { ChatScrollToLatest } from '@/components/ChatScrollToLatest'
import { apiCache } from '@/lib/api-cache'
import { groupReactionPaths, mergeGroupMessages } from '@/lib/group-history'
import { api } from '@/lib/api'
import { separatorLabel, startsGroup } from '@/lib/chat-time'
import { mentionsIn } from '@/lib/group'
import { useHome } from '@/lib/home'
import { clearHeldMessage, holdMessage, type HeldMessage } from '@/lib/message-actions'
import { plainText, quotable } from '@/lib/quote'
import { myReaction, toggled, withMine } from '@/lib/reactions'
import type { GroupMember, GroupMessage, GroupPage, GroupSummary, Reaction } from '@/lib/types'
import { useApi, useLiveApi } from '@/lib/useApi'
import { groupChatLive } from '@/lib/live-keys'
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
  const list = useRef<ChatListHandle>(null)
  const [atLatest, setAtLatest] = useState(true)
  const underBar = useScrolledUnderBar()
  const reduceMotion = useReducedMotionPreference()
  const apiContext = apiCache.context()
  const [composerHeight, setComposerHeight] = useState(90)
  const groups = useApi<{ conversations: GroupSummary[] }>(home.data ? `/api/conversations?workspaceId=${home.data.workspace.id}` : null)
  const summary = groups.data?.conversations.find(group => group.id === id)
  const title = summary?.title ?? ''
  // One key for this group's page (lib/live/groups.ts): a message, who is answering, a member, a reaction.
  const live = groupChatLive(id, summary?.workspaceId)
  // The newest page, 50 messages; a push reads only what came after the newest one shown (#1408).
  const pagePath = `/api/conversations/${id}/messages?limit=50`
  const readPage = useCallback(async (at: string) => mergeGroupRead(apiCache.get<GroupRead>(at), await api<GroupRead>(groupPagePath(id, apiCache.get<GroupRead>(at)))), [id])
  const page = useLiveApi<GroupRead>(pagePath, () => live, readPage)
  const membersPath = `/api/conversations/${id}/members`
  const members = useLiveApi<{ members: GroupMember[] }>(membersPath, () => live)
  // A server-confirmed loss of membership must hide this group's cached history and actions immediately.
  // A network failure or 5xx is not a membership decision and keeps the recoverable offline view.
  const accessDenied = conversationAccessDenied(page.error) || conversationAccessDenied(members.error)
  const identity = `${id}:${apiContext}`
  useLayoutEffect(() => {
    if (accessDenied) clearHeldMessage(identity)
    return () => clearHeldMessage(identity)
  }, [identity, accessDenied])
  // A screen can be reused for a different group or signed-in workspace without remounting.
  // Keep drafts attached to their original identity so an old group's text/quote is never shown in the new group.
  const [composerDraft, setComposerDraft] = useState<{ identity: string; text: string; quote: string | null }>(
    () => ({ identity, text: '', quote: null }),
  )
  const draftMatches = !accessDenied && composerDraft.identity === identity
  const text = draftMatches ? composerDraft.text : ''
  const quote = draftMatches ? composerDraft.quote : null
  const setText = (value: string) => setComposerDraft(current => ({
    identity, text: value, quote: current.identity === identity ? current.quote : null,
  }))
  const setQuote = (value: string | null) => setComposerDraft(current => ({
    identity, text: current.identity === identity ? current.text : '', quote: value,
  }))
  // Oldest first, as the chat reads.
  const messages = accessDenied ? [] : mergeGroupMessages([], page.data?.messages ?? [])
  // Only a message sent on this visit is anchored under the bar with room for the reply (v0); opening the chat,
  // older pages and pushes keep the latest message against the composer.
  const opened = useRef<{ identity: string; newest: bigint } | null>(null)
  if (page.data && opened.current?.identity !== identity) opened.current = { identity, newest: messages.reduce((max, message) => BigInt(message.position) > max ? BigInt(message.position) : max, -1n) }
  const [sentHere, setSentHere] = useState(false)
  const anchorIndex = sentHere ? latestOwnIndex(messages, message => message.authorType === 'user' && message.authorId === me && BigInt(message.position) > (opened.current?.newest ?? -1n)) : undefined
  const before = accessDenied ? null : page.data?.nextBefore ?? null
  const [historyError, setHistoryError] = useState<unknown>(null)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const historyRequest = useRef<object | null>(null)
  useEffect(() => { historyRequest.current = null; setLoadingHistory(false); setHistoryError(null) }, [identity])
  // Scrolling to the top loads the page before, a page at a time.
  const loadEarlier = async () => {
    if (accessDenied || !before || historyRequest.current) return
    const request = {}; historyRequest.current = request
    setLoadingHistory(true); setHistoryError(null)
    try {
      const earlier = await api<GroupPage>(groupPagePath(id, null, before))
      apiCache.commit(apiContext, () => { if (historyRequest.current === request) page.setData(current => current && mergeGroupHistory(current, earlier)) })
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
  const reactionState = useLiveApi<{ reactions: Record<string, Reaction[]> }>(ids ? `/api/mobile/reactions?ids=${ids}` : null, () => live, readReactions)
  const [reactionSnapshot, setReactionSnapshot] = useState<{ identity: string; reactions: Record<string, Reaction[]> } | null>(null)
  useEffect(() => { if (reactionState.data) setReactionSnapshot({ identity, reactions: reactionState.data.reactions }) }, [identity, reactionState.data])
  const reactions = reactionState.data?.reactions ?? (reactionSnapshot?.identity === identity ? reactionSnapshot.reactions : {})
  const reactionPending = useRef(new Map<string, object>())
  const [reactionFailure, setReactionFailure] = useState<{ id: string; emoji: string | null } | null>(null)
  useEffect(() => { reactionPending.current.clear(); setReactionFailure(null) }, [identity])
  // The existing cache reader revokes denied responses; clear screen-local state as well.
  // This does not erase other groups or treat temporary offline errors as revoked membership.
  useEffect(() => {
    if (!accessDenied) return
    setText('')
    setQuote(null)
    setSentHere(false)
    setReactionSnapshot(null)
    setReactionFailure(null)
    setHistoryError(null)
    setLoadingHistory(false)
    setStopFailed(false)
    setStopping(false)
    opened.current = null
    historyRequest.current = null
    reactionPending.current.clear()
  }, [accessDenied, identity])
  const working = Boolean(!accessDenied && page.data?.agentStatus)
  // 停止: the group's reply ends on the server; stop stays away until the group stops answering.
  const [stopping, setStopping] = useState(false)
  const [stopFailed, setStopFailed] = useState(false)
  const stopPending = useRef(false)
  useEffect(() => { if (!working) setStopping(false) }, [working])
  const stop = async () => {
    if (accessDenied || stopPending.current) return
    stopPending.current = true; setStopping(true); setStopFailed(false)
    try { await api(`/api/conversations/${id}/stop`, { method: 'POST' }); await page.reload() }
    catch { setStopping(false); setStopFailed(true) }
    finally { stopPending.current = false }
  }

  // What the person has seen: the newest message, once it is on screen.
  const newest = page.data?.messages[0]?.id ?? null
  const readRevision = page.data?.readRevision
  useEffect(() => {
    if (accessDenied || !atLatest || (!newest && readRevision === undefined)) return
    void api(`/api/conversations/${id}/read`, { method: 'POST', body: { messageId: newest, readRevision } }).catch(() => undefined)
  }, [id, newest, atLatest, readRevision, accessDenied])

  const member = (type: string, memberId: string) => members.data?.members.find(item => item.memberType === type && item.id === memberId)
  const bots = accessDenied ? [] : (members.data?.members ?? []).filter(item => item.memberType !== 'user')

  const canSend = Boolean(page.data && members.data && !accessDenied)
  const revoked = apiCache.denial(pagePath) || apiCache.denial(membersPath)
  const delivery = useConversationDelivery(canSend ? { kind: 'group', id } : null, messages.map(message => message.id), page.reload, revoked ? id : undefined)
  const send = (body: string) => {
    const queued = delivery.send(body, mentionsIn(body, bots))
    if (queued) {
      setSentHere(true)
      list.current?.toLatest(!reduceMotion)
    }
    return queued
  }

  const react = async (messageId: string, emoji: string | null) => {
    if (accessDenied || reactionPending.current.has(messageId)) return
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

  const held = (words: string, messageId: string): HeldMessage => ({ scope: identity, text: plainText(words), onQuote: () => setQuote(quotable(words)), react: { current: myReaction(reactions[messageId]), set: emoji => void react(messageId, emoji) } })
  // A long press selects the words: a group has no in-place selection, so they open selectable (app/message-text.tsx).
  const select = (words: string, messageId: string) => {
    holdMessage(held(words, messageId))
    router.push('/message-text')
  }
  const chips = (messageId: string, align?: 'right') => <Reactions reactions={reactions[messageId]} align={align} onToggle={emoji => void react(messageId, toggled(reactions[messageId], emoji))} />

  const renderMessage = (message: GroupMessage, index: number) => {
    const separator = startsGroup(message.createdAt, messages[index - 1]?.createdAt) ? <TimeSeparator label={separatorLabel(message.createdAt)} /> : null
    if (message.authorType === 'user' && message.authorId === me) {
      return (
        <View>
          {separator}
          <MessageRow align="right" onSelect={() => select(message.body, message.id)}>
            <MyBubble text={message.body} />{chips(message.id, 'right')}
          </MessageRow>
        </View>
      )
    }
    const author = member(message.authorType, message.authorId)
    const previous = messages[index - 1]
    const first = !previous || previous.authorType !== message.authorType || previous.authorId !== message.authorId
    return (
      <View>
      {separator}
      <MessageRow onSelect={() => select(message.body, message.id)}>
        {first || separator ? (
          <View style={styles.author}>
            {message.authorType === 'user' ? null : <BotAvatar color={author?.color} shape={author?.shape} size={20} />}
            <Text style={styles.authorName}>{author?.name ?? (message.authorType === 'user' ? '成员' : 'Bot')}</Text>
          </View>
        ) : null}
        <BotBubble><Markdown text={message.body} /></BotBubble>
        {chips(message.id)}
        <MessageActions message={held(message.body, message.id)} copy={message.authorType !== 'user'} />
      </MessageRow>
      </View>
    )
  }

  return (
    <View style={styles.screen}>
      <NavBar title={accessDenied ? '' : title} scrolled={underBar.scrolled} />
      <View style={{ flex: 1, overflow: 'hidden' }}>
        <ChatMessageList ref={list} testID="group-chat-scroll" data={messages} scrollEnabled onScrollUnderBar={underBar.onScroll} bottomInset={composerHeight} onAtLatestChange={setAtLatest}
          keyOf={message => message.id} renderItem={renderMessage} anchorIndex={anchorIndex}
          onStartReached={before ? () => void loadEarlier() : undefined}
          header={<>
            {!page.data && !page.error ? <View style={styles.loading}><Spinner /></View> : null}
            <ReadNotice error={page.error} hasData={Boolean(page.data)} label="群聊" onRetry={page.reload} />
            <ReadNotice error={reactionState.error} hasData={reactionSnapshot?.identity === identity} label="回应" onRetry={reactionState.reload} />
            <ReadNotice error={members.error} hasData={Boolean(members.data)} label="群成员" onRetry={members.reload} />
            {loadingHistory ? <View style={styles.history}><Spinner size={16} /></View> : null}
            <ReadNotice error={historyError} label="更早消息" onRetry={loadEarlier} />
          </>}
          footer={<>
        {working ? <View style={styles.working}><Spinner size={16} /></View> : null}
        {!accessDenied && page.data && !messages.length && !delivery.bubbles.length ? <Text style={styles.empty}>@ 一个 Bot，或直接说</Text> : null}
        {!accessDenied && page.data?.routingError && !working ? <Text style={styles.error}>没有 Bot 接这条，@ 它的名字</Text> : null}
        {!accessDenied && page.data?.stopped && !working ? <Text style={styles.stopped}>已停止</Text> : null}
        {delivery.bubbles}
        {stopFailed ? <StopFailed busy={stopping} onRetry={() => void stop()} /> : null}
          </>} />
        <ListTopFade color={colors.page} />
      </View>
      <ChatScrollToLatest visible={!accessDenied && !atLatest} bottom={composerHeight + 12} onPress={() => list.current?.toLatest()} />
      <OfflineBanner top={insets.top + 66} />
      {!accessDenied ? <Composer value={text} onChangeText={setText} placeholder={`发到 ${title || '群聊'}`} onSend={words => send(words)} sendDisabled={!canSend} attach attachmentScope={{ kind: 'group', id }} overlay onHeight={setComposerHeight}
        notice={reactionFailure ? <View accessibilityRole="alert" style={styles.reactionNotice}><Text style={styles.error}>回应没保存。</Text><GlassButton label="重试" onPress={() => void react(reactionFailure.id, reactionFailure.emoji)} /></View> : undefined}
        quote={quote} onClearQuote={() => setQuote(null)} onStop={working && !stopping ? () => void stop() : undefined} /> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
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
