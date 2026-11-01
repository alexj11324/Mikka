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
import { api } from '@/lib/api'
import type { ThreadDetail } from '@/lib/types'
import { useApi } from '@/lib/useApi'
import { colors } from '@/lib/theme'

const STATUS_WORD = { running: '运行中', waiting: '等你回复', failed: '失败', done: '完成', stopped: '已停止' } as const
const HARNESS: Record<string, string> = { claude_code: 'Claude Code', codex: 'Codex' }

/** A thread's own page, pushed from a thread card or the 线程 list; back returns (mobile.md). */
export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { data, error, reload } = useApi<ThreadDetail>(`/api/mobile/threads/${id}`, 4000)
  const [sending, setSending] = useState(false)
  const [sendFailed, setSendFailed] = useState(false)
  const thread = data?.thread

  const send = async (text: string) => {
    setSending(true)
    setSendFailed(false)
    try {
      await api(`/api/mobile/threads/${id}`, { method: 'POST', body: { text } })
      await reload()
      return true
    } catch {
      // The composer keeps the words, so sending again is one tap.
      setSendFailed(true)
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
                <Text style={styles.subtitle} numberOfLines={1}>{STATUS_WORD[thread.status]} · {thread.by} · {HARNESS[thread.harness] ?? thread.harness}</Text>
                {thread.device ? <MachineIcon machine={thread.device.kind} size={11} /> : null}
              </View>
            </View>
          </View>
        ) : undefined}
      />
      <KeyboardChatScrollView {...underBar} offset={Math.max(insets.bottom, 12) - 8} keyboardDismissMode="interactive" keyboardLiftBehavior="whenAtEnd" contentContainerStyle={styles.body}>
        {!data && !error ? <View style={{ paddingTop: 40, alignItems: 'center' }}><Spinner /></View> : null}
        {error && !data ? <Text style={styles.error}>线程加载失败。</Text> : null}
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
        {sendFailed ? <Text style={styles.error}>没发出去，再试一次。</Text> : null}
        {data && !data.active && data.error && !data.items.some(item => item.kind === 'error') ? <Text style={styles.error}>{data.error}</Text> : null}
      </KeyboardChatScrollView>
      <OfflineBanner top={insets.top + 66} />
      {data?.active ? <Composer placeholder="给这个线程发消息" onSend={send} disabled={sending} /> : null}
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
})
