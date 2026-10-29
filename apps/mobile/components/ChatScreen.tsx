import { Fragment, useEffect, useRef, useState } from 'react'
import { ScrollView, StyleSheet, View, type ScrollViewInstance } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ListChecks } from 'lucide-react-native'
import { useDrawer } from '@/components/Drawer'
import { BotAvatar, MenuIcon, Spinner, threadStatus } from '@/components/icons'
import { CardButton } from '@/components/cards'
import { BotBubble, EventLine, MyBubble, OutgoingBubble, ThreadCard, TimedRow, useTimeReveal } from '@/components/chat'
import { Markdown } from '@/components/Markdown'
import { OfflineBanner } from '@/components/OfflineBanner'
import { OpenUIReply } from '@/components/OpenUI'
import { PendingActions } from '@/components/PendingActions'
import { Text } from '@/components/Text'
import { Composer, Header, RoundButton } from '@/components/ui'
import { api } from '@/lib/api'
import { clockTime } from '@/lib/clock'
import { isOpenUI } from '@/lib/openui'
import { delivered, inFlight, marked, outgoingKey, queued, type Outgoing } from '@/lib/outbox'
import { askForPush, usePushState } from '@/lib/push-state'
import { runTitle, type Chat, type CitationSource, type PendingAction } from '@/lib/types'
import { useApi } from '@/lib/useApi'
import { webChatPath } from '@/lib/web'
import { colors, lift } from '@/lib/theme'

const RUN_ENDED = /^\[Event\] Run ([0-9a-f-]{36}) ended with status (\w+)/i
const ENDED_WORD: Record<string, string> = { succeeded: '完成了', failed: '失败了', stopped: '已停止', cancelled: '已取消' }

/** An event line: a run that ended reads as its thread's name and how it ended; others as the web shows them. */
function eventText(text: string, sources: Record<string, CitationSource>) {
  const ended = RUN_ENDED.exec(text)
  const run = ended ? sources[ended[1].toLowerCase()] : undefined
  if (ended && run?.kind === 'run') return `${runTitle(run)} ${ENDED_WORD[ended[2]] ?? ended[2]}`
  return text.replace(/^\[Event\]\s*/, '')
}

/**
 * A chat with a bot; the Coordinator is one (R-06): the bot's name in a pill,
 * the threads behind the right button, the composer at the bottom. Polls while
 * a reply is coming. Below the messages sit the proposals waiting for the
 * person (approve or decline, as on the web); `focus` marks the one a push
 * was about. OpenUI cards are drawn natively (components/OpenUI.tsx).
 */
export function ChatScreen({ botId, name, color, shape, draft, focus }: { botId: string | null; name: string; color?: string; shape?: string; draft?: string; focus?: string }) {
  const drawer = useDrawer()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const scroll = useRef<ScrollViewInstance>(null)
  const { offset, handlers } = useTimeReveal()
  const path = `/api/mobile/chat${botId ? `?bot=${botId}` : ''}`
  const [fast, setFast] = useState(false)
  const { data, error, reload } = useApi<Chat>(path, fast ? 2500 : 15000)
  const pending = useApi<PendingAction[]>('/api/pending-actions', 10000)
  const [outbox, setOutbox] = useState<Outgoing[]>([])
  const [text, setText] = useState(draft ?? '')
  const working = Boolean(data?.working) || inFlight(outbox)
  const push = usePushState()
  // Opened from a push about a proposal: its card is scrolled into view once, instead of the chat's end.
  const pendingTop = useRef(0)
  const [pinned, setPinned] = useState(false)
  const showFocus = (y: number) => {
    if (pinned) return
    setPinned(true)
    // After this frame's layout, so the list's own offset (measured after its children) is known.
    setTimeout(() => scroll.current?.scrollTo({ y: Math.max(0, pendingTop.current + y - insets.top - 84), animated: true }), 0)
  }
  useEffect(() => { setPinned(false) }, [focus])

  useEffect(() => { setFast(working) }, [working])
  useEffect(() => { if (draft) setText(draft) }, [draft])

  const items = data?.items ?? []
  const sources = data?.sources ?? {}
  // A card is answered once the person has written after it (here or anywhere else).
  const lastMine = items.reduce((last, item, index) => item.from === 'person' ? index : last, -1)
  const proactive = items.some((item, index) => item.from === 'coordinator' && items[index - 1]?.from === 'event')

  // iOS asks once; the moment is the first message the Coordinator sent on its own, not app launch.
  useEffect(() => { if (proactive && push === 'undetermined') void askForPush() }, [proactive, push])

  const open = (source: CitationSource) => {
    if (source.kind === 'run') router.push(`/threads/${source.id}`)
    else router.push('/tasks')
  }

  const deliver = async (key: string, message: string) => {
    try {
      await api('/api/mobile/chat', { method: 'POST', body: { text: message, botId } })
      await reload()
      setOutbox(list => delivered(list, key))
      return true
    } catch {
      setOutbox(list => marked(list, key, 'failed'))
      return false
    }
  }

  const send = async (message: string) => {
    setPinned(false)
    const key = outgoingKey()
    setOutbox(list => queued(list, key, message))
    return deliver(key, message)
  }

  const retry = async (item: Outgoing) => {
    setOutbox(list => marked(list, item.key, 'sending'))
    // The composer still holds the words of a failed send; once they arrive it empties.
    if (await deliver(item.key, item.text)) setText(current => current.trim() === item.text ? '' : current)
  }

  const answer = async (message: string) => send(message)

  return (
    <View style={styles.screen}>
      <Header
        style={styles.header}
        left={<RoundButton label="菜单" onPress={drawer.open}><MenuIcon /></RoundButton>}
        title={
          <View style={styles.pill}>
            <BotAvatar color={color} shape={shape} size={22} />
            <Text style={styles.pillText} numberOfLines={1}>{name}</Text>
          </View>
        }
        right={<RoundButton label="线程" onPress={() => router.push('/threads')}><ListChecks size={21} color={colors.ink} strokeWidth={2} /></RoundButton>}
      />
      <OfflineBanner top={insets.top + 66} />
      <View style={{ flex: 1, overflow: 'hidden' }} {...handlers}>
        <ScrollView ref={scroll} contentContainerStyle={[styles.list, { paddingTop: insets.top + 76 }]} onContentSizeChange={() => { if (!pinned) scroll.current?.scrollToEnd({ animated: false }) }}>
          {items.map((item, index) => {
            const time = clockTime(item.createdAt)
            return (
              <Fragment key={item.pending ? `pending-${item.position}` : item.position}>
                {item.from === 'event' ? <EventLine text={eventText(item.text, sources)} /> : null}
                {item.from === 'person' && item.text ? <TimedRow time={time} offset={offset} align="right"><MyBubble text={item.text} /></TimedRow> : null}
                {item.from === 'coordinator' && item.text ? (
                  <TimedRow time={time} offset={offset}>
                    {isOpenUI(item.text)
                      ? <OpenUIReply text={item.text} live={index > lastMine && !outbox.length} reply={items.slice(index + 1).find(next => next.from === 'person')?.text} answer={answer} webPath={webChatPath(botId)} sources={sources} onOpen={open} />
                      : <BotBubble><Markdown text={item.text} sources={sources} onOpen={open} /></BotBubble>}
                  </TimedRow>
                ) : null}
                {item.threads.map(id => {
                  const run = sources[id]
                  return run?.kind === 'run'
                    ? <TimedRow key={id} time={time} offset={offset}><ThreadCard title={runTitle(run)} status={threadStatus(run.status)} onPress={() => router.push(`/threads/${id}`)} /></TimedRow>
                    : null
                })}
              </Fragment>
            )
          })}
          {outbox.map(item => <OutgoingBubble key={item.key} text={item.text} failed={item.state === 'failed'} onRetry={() => void retry(item)} />)}
          {working ? <View style={styles.working}><Spinner size={16} /></View> : null}
          {data && !items.length && !working ? <Text style={styles.empty}>有什么要我做的，直接说。</Text> : null}
          {error && !data ? (
            <View style={styles.failed}>
              <Text style={styles.error}>连不上 Mikka。</Text>
              <CardButton label="重试" onPress={() => void reload()} />
            </View>
          ) : null}
          {data?.error && !working ? <Text style={styles.error}>{data.error}</Text> : null}
          {pending.data ? (
            <View onLayout={event => { pendingTop.current = event.nativeEvent.layout.y }}>
              <PendingActions items={pending.data} focus={focus} reload={pending.reload} onFocusLayout={focus ? showFocus : undefined} />
            </View>
          ) : null}
        </ScrollView>
      </View>
      <Composer value={text} onChangeText={setText} placeholder={`给 ${name} 发消息`} onSend={send} />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  // Floats over the messages; a light veil keeps text from showing through the buttons.
  header: { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: 'rgba(255,255,255,0.94)' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 44, paddingHorizontal: 16, borderRadius: 22, backgroundColor: '#fff', maxWidth: 220, ...lift },
  pillText: { fontSize: 16, fontWeight: '600' },
  // Space above the composer (适度留白).
  list: { paddingBottom: 28, paddingHorizontal: 16, gap: 12 },
  working: { alignSelf: 'flex-start', backgroundColor: colors.bubble, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 12 },
  failed: { alignItems: 'center', gap: 10, marginTop: 24 },
  empty: { alignSelf: 'center', color: colors.secondary, marginTop: 40, fontSize: 15 },
  error: { alignSelf: 'center', color: colors.danger, fontSize: 13, textAlign: 'center', marginHorizontal: 24 },
})
