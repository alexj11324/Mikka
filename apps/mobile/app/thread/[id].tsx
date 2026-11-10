import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { KeyboardChatScrollView } from 'react-native-keyboard-controller'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Square } from 'lucide-react-native'
import { BotBubble, MyBubble } from '@/components/chat'
import { Spinner, StatusIcon } from '@/components/icons'
import { ThreadPlace } from '@/components/ThreadPlace'
import { Markdown } from '@/components/Markdown'
import { OfflineBanner } from '@/components/OfflineBanner'
import { Text } from '@/components/Text'
import { NavBar, underBar } from '@/components/NavBar'
import { useScrolledUnderBar } from '@/components/BarBackdrop'
import { ThreadSteps } from '@/features/tasks/components/thread-steps'
import { Composer } from '@/features/chat/components/chat-composer'
import { api, ApiError } from '@/lib/api'
import { ReadNotice } from '@/components/ReadNotice'
import { StopFailed } from '@/components/StopFailed'
import { ThreadQuotaPaused } from '@/components/ThreadQuotaPaused'
import { useStop } from '@/lib/useStop'
import { composerStops } from '@/lib/stop'
import { threadSendErrorLine } from '@/lib/thread-send-error'
import type { ThreadDetail } from '@/lib/types'
import { useLiveApi } from '@/lib/useApi'
import { threadLive } from '@/lib/live-keys'
import { colors } from '@/lib/theme'

const STATUS_WORD = { running: '运行中', waiting: '等待你', paused: '已暂停', failed: '失败', done: '完成', stopped: '已停止' } as const

/** A thread without a task, pushed from its card; a task's threads open as the task's one conversation (app/task/[id]/conversation.tsx). */
export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const bar = useScrolledUnderBar()
  // Read again when one of its runs writes text or changes state (the web's thread and run keys); an
  // ended thread changes only when it runs again. Each read is the whole conversation.
  const { data, error, reload } = useLiveApi<ThreadDetail>(`/api/mobile/threads/${id}`, current => threadLive(current, id))
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
        scrolled={bar.scrolled}
        back={() => (router.canGoBack() ? router.back() : router.replace('/tasks'))}
        titleView={thread ? (
          <View style={styles.titleRow}>
            <StatusIcon status={thread.status} size={18} />
            <View style={{ flexShrink: 1 }}>
              <Text style={styles.title} numberOfLines={1}>{thread.name}</Text>
              <View style={styles.subtitleRow}>
                {/* Icons only after the state: where it runs; a tap names the machine (Alex, 2026-11-06). */}
                <Text style={styles.subtitle} numberOfLines={1}>{error ? '上次状态：' : ''}{STATUS_WORD[thread.status]}{thread.device ? ' ·' : ''}</Text>
                {thread.device ? <ThreadPlace threadId={id} kind={thread.device.kind} /> : null}
              </View>
            </View>
          </View>
        ) : undefined}
        // Stop for every live thread, also one waiting for your answer, whose composer sends (N1).
        right={data?.active && !stopper.sending ? { icon: 'stop.fill', label: '停止', web: <Square size={18} color={colors.ink} fill={colors.ink} />, onPress: () => void stopper.stop() } : undefined}
      />
      <KeyboardChatScrollView onScroll={bar.onScroll} scrollEventThrottle={16} {...underBar} offset={Math.max(insets.bottom, 12) - 8} keyboardDismissMode="interactive" keyboardLiftBehavior="whenAtEnd" contentContainerStyle={styles.body}>
        {!data && !error ? <View style={{ paddingTop: 40, alignItems: 'center' }}><Spinner /></View> : null}
        <ReadNotice error={error} hasData={Boolean(data)} label="线程" onRetry={reload} />
        {data?.items.map((item, index) => {
          switch (item.kind) {
            case 'steps':
              return <ThreadSteps key={item.id} steps={item.steps} count={item.count} live={data.active && index === data.items.length - 1} />
            case 'agent': return <View key={item.id} style={{ marginVertical: 4 }}><BotBubble><Markdown text={item.text} /></BotBubble></View>
            case 'error': return <Text key={item.id} style={styles.error}>{item.text}</Text>
            case 'person': return <View key={item.id} style={{ marginVertical: 4 }}><MyBubble text={item.text} /></View>
          }
        })}
        {sendFailed ? <Text style={styles.error}>{sendFailed}</Text> : null}
        {data?.paused ? <ThreadQuotaPaused key={data.paused.runId} paused={data.paused} onContinued={async runId => { if (runId !== id) router.replace(`/thread/${runId}`); await reload() }} /> : null}
        {stopper.stuck ? <StopFailed busy={stopper.sending} onRetry={() => void stopper.stop()} /> : null}
        {data && !data.active && data.error && !data.items.some(item => item.kind === 'error') ? <Text style={styles.error}>{data.error}</Text> : null}
      </KeyboardChatScrollView>
      <OfflineBanner top={insets.top + 66} />
      {/* R-10: a thread ends in the composer, finished or not; a message to an ended thread runs it again (R-81). */}
      {data ? <Composer placeholder="给这个线程发消息" onSend={send} disabled={sending} attach attachmentScope={{ kind: 'thread', id }} onStop={composerStops(data) && !stopper.sending ? () => void stopper.stop() : undefined} /> : null}
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
  error: { fontSize: 14, color: colors.danger, marginVertical: 4 },
})
