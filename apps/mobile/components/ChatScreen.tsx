import { Fragment, useEffect, useRef, useState } from 'react'
import { Linking, ScrollView, StyleSheet, View, type ScrollViewInstance } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ListChecks } from 'lucide-react-native'
import { useDrawer } from '@/components/Drawer'
import { BotAvatar, MenuIcon, Spinner, threadStatus } from '@/components/icons'
import { BotBubble, DateLabel, EventLine, MyBubble, ThreadCard, TimedRow, useTimeReveal } from '@/components/chat'
import { Markdown } from '@/components/Markdown'
import { Text } from '@/components/Text'
import { Composer, Header, RoundButton } from '@/components/ui'
import { api } from '@/lib/api'
import { clockTime, dayLabel } from '@/lib/clock'
import { API_URL } from '@/lib/config'
import { runTitle, type Chat, type CitationSource } from '@/lib/types'
import { useApi } from '@/lib/useApi'
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

/** OpenUI cards (lib/coordinator/native-prompt.ts) are drawn by the web's renderer only. */
const OPEN_UI = /^\s*root\s*=/

/**
 * A chat with a bot; the Coordinator is one (R-06): the bot's name in a pill,
 * the threads behind the right button, the composer at the bottom. Polls while
 * a reply is coming.
 */
export function ChatScreen({ botId, name, color, shape, draft }: { botId: string | null; name: string; color?: string; shape?: string; draft?: string }) {
  const drawer = useDrawer()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const scroll = useRef<ScrollViewInstance>(null)
  const { offset, handlers } = useTimeReveal()
  const path = `/api/mobile/chat${botId ? `?bot=${botId}` : ''}`
  const [fast, setFast] = useState(false)
  const { data, error, reload } = useApi<Chat>(path, fast ? 2500 : 15000)
  const [sending, setSending] = useState<string[]>([])
  const [sendFailed, setSendFailed] = useState(false)
  const working = Boolean(data?.working) || sending.length > 0

  useEffect(() => { setFast(working) }, [working])

  const open = (source: CitationSource) => {
    if (source.kind === 'run') router.push(`/threads/${source.id}`)
    else router.push('/tasks')
  }

  const send = async (text: string) => {
    setSending(list => [...list, text])
    setSendFailed(false)
    try {
      await api(`/api/mobile/chat`, { method: 'POST', body: { text, botId } })
      await reload()
    } catch {
      setSendFailed(true)
    } finally {
      setSending(list => list.filter(item => item !== text))
    }
  }

  const items = data?.items ?? []
  const sources = data?.sources ?? {}
  let lastDay = ''

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
      <View style={{ flex: 1, overflow: 'hidden' }} {...handlers}>
        <ScrollView ref={scroll} contentContainerStyle={[styles.list, { paddingTop: insets.top + 76 }]} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}>
          {items.map(item => {
            const day = dayLabel(item.createdAt)
            const showDay = day !== lastDay
            lastDay = day
            const time = clockTime(item.createdAt)
            return (
              <Fragment key={item.pending ? `pending-${item.position}` : item.position}>
                {showDay ? <DateLabel text={day} /> : null}
                {item.from === 'event' ? <EventLine text={eventText(item.text, sources)} /> : null}
                {item.from === 'person' && item.text ? <TimedRow time={time} offset={offset} align="right"><MyBubble text={item.text} /></TimedRow> : null}
                {item.from === 'coordinator' && item.text ? (
                  <TimedRow time={time} offset={offset}>
                    <BotBubble>
                      {OPEN_UI.test(item.text)
                        ? <Text style={styles.webOnly} onPress={() => void Linking.openURL(API_URL)}>卡片 · 在网页上查看</Text>
                        : <Markdown text={item.text} sources={sources} onOpen={open} />}
                    </BotBubble>
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
          {sending.map(text => <MyBubble key={`sending-${text}`} text={text} />)}
          {working ? <View style={styles.working}><Spinner size={16} /></View> : null}
          {data && !items.length && !working ? <Text style={styles.empty}>有什么要我做的，直接说。</Text> : null}
          {error && !data ? <Text style={styles.error}>连不上 Mikka，稍后再试。</Text> : null}
          {data?.error && !working ? <Text style={styles.error}>{data.error}</Text> : null}
          {sendFailed ? <Text style={styles.error}>没发出去，再试一次。</Text> : null}
        </ScrollView>
      </View>
      <Composer key={draft ?? ''} initial={draft} placeholder={`给 ${name} 发消息`} onSend={send} />
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
  webOnly: { fontSize: 15, color: colors.accent },
  empty: { alignSelf: 'center', color: colors.secondary, marginTop: 40, fontSize: 15 },
  error: { alignSelf: 'center', color: colors.danger, fontSize: 13, textAlign: 'center', marginHorizontal: 24 },
})
