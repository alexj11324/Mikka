import { useEffect, useRef, useState } from 'react'
import { StyleSheet, View, type ScrollViewInstance } from 'react-native'
import { KeyboardChatScrollView } from 'react-native-keyboard-controller'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { BotAvatar, Spinner } from '@/components/icons'
import { BotBubble, CopyButton, MyBubble, Reactions, TimedRow, useTimeReveal } from '@/components/chat'
import { Markdown } from '@/components/Markdown'
import { NavBar, underBar } from '@/components/NavBar'
import { Text } from '@/components/Text'
import { Composer } from '@/components/ui'
import { api } from '@/lib/api'
import { clockTime } from '@/lib/clock'
import { mentionsIn } from '@/lib/group'
import { useHome } from '@/lib/home'
import { holdMessage } from '@/lib/message-actions'
import { plainText, quotable } from '@/lib/quote'
import { myReaction, toggled, withMine } from '@/lib/reactions'
import type { GroupMember, GroupPage, GroupSummary, Reaction } from '@/lib/types'
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
  const [composerHeight, setComposerHeight] = useState(90)
  const [text, setText] = useState('')
  const [quote, setQuote] = useState<string | null>(null)
  const [sendFailed, setSendFailed] = useState(false)
  const groups = useApi<{ conversations: GroupSummary[] }>(home.data ? `/api/conversations?workspaceId=${home.data.workspace.id}` : null)
  const title = groups.data?.conversations.find(group => group.id === id)?.title ?? ''
  const [fast, setFast] = useState(false)
  const page = useApi<GroupPage>(`/api/conversations/${id}/messages?limit=100`, fast ? 2500 : 8000)
  const members = useApi<{ members: GroupMember[] }>(`/api/conversations/${id}/members`, 60_000)
  const messages = [...page.data?.messages ?? []].reverse()
  const ids = messages.map(message => message.id).slice(-100).join(',')
  const reactionState = useApi<{ reactions: Record<string, Reaction[]> }>(ids ? `/api/mobile/reactions?ids=${ids}` : null, 15_000)
  const reactions = reactionState.data?.reactions ?? {}
  const working = Boolean(page.data?.agentStatus)
  useEffect(() => { setFast(working) }, [working])

  // What the person has seen: the newest message, once it is on screen.
  const newest = page.data?.messages[0]?.id
  useEffect(() => { if (newest) void api(`/api/conversations/${id}/read`, { method: 'POST', body: { messageId: newest } }).catch(() => undefined) }, [id, newest])

  const member = (type: string, memberId: string) => members.data?.members.find(item => item.memberType === type && item.id === memberId)
  const bots = (members.data?.members ?? []).filter(item => item.memberType !== 'user')

  // The composer has put the quote ahead of the words and clears both once this returns true.
  const send = async (body: string) => {
    setSendFailed(false)
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
    reactionState.setData(current => ({ reactions: { ...current?.reactions, [messageId]: withMine(current?.reactions?.[messageId], emoji) } }))
    try { await api('/api/mobile/reactions', { method: 'POST', body: { messageId, emoji } }) } finally { void reactionState.reload() }
  }
  const actions = (words: string, messageId: string) => {
    holdMessage({ text: plainText(words), onQuote: () => setQuote(quotable(words)), react: { current: myReaction(reactions[messageId]), set: emoji => void react(messageId, emoji) } })
    router.push('/message')
  }
  const chips = (messageId: string, align?: 'right') => <Reactions reactions={reactions[messageId]} align={align} onToggle={emoji => void react(messageId, toggled(reactions[messageId], emoji))} />

  return (
    <View style={styles.screen}>
      <NavBar title={title} />
      <View style={{ flex: 1, overflow: 'hidden' }} {...handlers}>
        <KeyboardChatScrollView ref={scroll} {...underBar} offset={Math.max(insets.bottom, 12) - 8} keyboardDismissMode="interactive" keyboardLiftBehavior="whenAtEnd"
          contentContainerStyle={[styles.list, { paddingBottom: composerHeight + 16 }]} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}>
          {!page.data && !page.error ? <View style={styles.loading}><Spinner /></View> : null}
          {page.error && !page.data ? <Text style={styles.error}>群聊加载失败</Text> : null}
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
          {sendFailed ? <Text style={styles.error}>没发出去</Text> : null}
        </KeyboardChatScrollView>
      </View>
      <Composer value={text} onChangeText={setText} placeholder={`发到 ${title || '群聊'}`} onSend={words => send(words)} overlay onHeight={setComposerHeight}
        quote={quote} onClearQuote={() => setQuote(null)} />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  list: { paddingHorizontal: 16, gap: 12 },
  loading: { paddingTop: 120, alignItems: 'center' },
  author: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  authorName: { fontSize: 13, color: colors.secondary },
  working: { alignSelf: 'flex-start', backgroundColor: colors.bubble, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 12 },
  empty: { alignSelf: 'center', color: colors.secondary, marginTop: 40, fontSize: 15 },
  error: { alignSelf: 'center', color: colors.danger, fontSize: 13, textAlign: 'center', marginHorizontal: 24 },
})
