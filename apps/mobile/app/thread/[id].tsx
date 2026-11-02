import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { KeyboardChatScrollView } from 'react-native-keyboard-controller'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Check } from 'lucide-react-native'
import { BotBubble, MyBubble } from '@/components/chat'
import { MachineIcon, Spinner, StatusIcon } from '@/components/icons'
import { Markdown } from '@/components/Markdown'
import { OfflineBanner } from '@/components/OfflineBanner'
import { Text } from '@/components/Text'
import { NavBar, underBar } from '@/components/NavBar'
import { Composer } from '@/components/ui'
import { api, ApiError } from '@/lib/api'
import { CardButton } from '@/components/cards'
import { StopFailed } from '@/components/StopFailed'
import { useStop } from '@/lib/useStop'
import { threadSendErrorLine } from '@/lib/thread-send-error'
import type { ThreadDetail } from '@/lib/types'
import { useApi } from '@/lib/useApi'
import { colors } from '@/lib/theme'
import { HARNESS } from '@/lib/harness'

const STATUS_WORD = { running: '运行中', waiting: '等待你', paused: '已暂停', failed: '失败', done: '完成', stopped: '已停止' } as const

/** A thread's own page, pushed from a thread card or the 线程 list; back returns (mobile.md). */
export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { data, error, reload } = useApi<ThreadDetail>(`/api/mobile/threads/${id}`, 4000)
  const [sending, setSending] = useState(false)
  // What to say when a message was not sent: the server's reason when it gave one (threadReplaced…).
  const [sendFailed, setSendFailed] = useState<string | null>(null)
  const thread = data?.thread
  // 停止 a working thread, as on the web; a thread that ended meanwhile (409) has nothing left to stop.
  const stopper = useStop(() => api(`/api/mobile/threads/${id}/stop`, { method: 'POST' }).catch(failure => {
    if (!(failure instanceof ApiError && failure.status === 409)) throw failure
  }), Boolean(data?.active), reload)

  const send = async (text: string) => {
    setSending(true)
    setSendFailed(null)
    try {
      await api(`/api/mobile/threads/${id}`, { method: 'POST', body: { text } })
      await reload()
      return true
    } catch (failure) {
      // The composer keeps the words, so sending again is one tap.
      setSendFailed(threadSendErrorLine(failure instanceof ApiError && failure.status < 500 ? failure.code : null))
      return false
    } finally {
      setSending(false)
    }
  }

  return (
    <View style={styles.screen}>
      <NavBar
        back={() => (router.canGoBack() ? router.back() : router.replace('/threads'))}
        titleView={thread ? (
          <View style={styles.titleRow}>
            <StatusIcon status={thread.status} size={18} />
            <View style={{ flexShrink: 1 }}>
              <Text style={styles.title} numberOfLines={1}>{thread.name}</Text>
              <View style={styles.subtitleRow}>
                <Text style={styles.subtitle} numberOfLines={1}>{STATUS_WORD[thread.status]} · {HARNESS[thread.harness] ?? thread.harness}</Text>
                {thread.device ? <MachineIcon machine={thread.device.kind} size={11} /> : null}
              </View>
            </View>
          </View>
        ) : undefined}
      />
      <KeyboardChatScrollView {...underBar} offset={Math.max(insets.bottom, 12) - 8} keyboardDismissMode="interactive" keyboardLiftBehavior="whenAtEnd" contentContainerStyle={styles.body}>
        {!data && !error ? <View style={{ paddingTop: 40, alignItems: 'center' }}><Spinner /></View> : null}
        {error && !data ? (
          <View style={styles.failed}>
            <Text style={styles.error}>线程加载失败。</Text>
            <CardButton label="重试" onPress={() => void reload()} />
          </View>
        ) : null}
        {data?.items.map((item, index) => {
          switch (item.kind) {
            case 'steps': {
              const live = data.active && index === data.items.length - 1
              return (
                <View key={item.id} style={styles.step}>
                  {live ? <Spinner size={14} /> : <Check size={15} color={colors.secondary} strokeWidth={2.2} />}
                  <Text style={styles.stepText}>{item.count} 步</Text>
                </View>
              )
            }
            case 'agent': return <View key={item.id} style={{ marginVertical: 4 }}><BotBubble><Markdown text={item.text} /></BotBubble></View>
            case 'error': return <Text key={item.id} style={styles.error}>{item.text}</Text>
            case 'person': return <View key={item.id} style={{ marginVertical: 4 }}><MyBubble text={item.text} /></View>
          }
        })}
        {sendFailed ? <Text style={styles.error}>{sendFailed}</Text> : null}
        {stopper.stuck ? <StopFailed busy={stopper.sending} onRetry={() => void stopper.stop()} /> : null}
        {data && !data.active && data.error && !data.items.some(item => item.kind === 'error') ? <Text style={styles.error}>{data.error}</Text> : null}
      </KeyboardChatScrollView>
      <OfflineBanner top={insets.top + 66} />
      {/* R-10: a thread ends in the composer, finished or not; a message to an ended thread runs it again (R-81). */}
      {data ? <Composer placeholder="给这个线程发消息" onSend={send} disabled={sending} onStop={data.active && !stopper.sending ? () => void stopper.stop() : undefined} /> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: 260 },
  title: { fontSize: 16, fontWeight: '600' },
  subtitleRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 1 },
  subtitle: { fontSize: 11, color: colors.secondary, flexShrink: 1 },
  body: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24, gap: 4 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 26 },
  stepText: { fontSize: 14, color: colors.secondary },
  error: { fontSize: 14, color: colors.danger, marginVertical: 4 },
  failed: { alignItems: 'center', gap: 10, marginTop: 24 },
})
