import { useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Check } from 'lucide-react-native'
import { BotBubble, MyBubble } from '@/components/chat'
import { Spinner, StatusIcon } from '@/components/icons'
import { Text } from '@/components/Text'
import { BackButton, Composer, Header } from '@/components/ui'
import { machines, threadSteps, threads } from '@/lib/mock'
import { colors } from '@/lib/theme'

const STATUS_WORD = { running: '运行中', waiting: '等你回复', review: '待审阅', failed: '失败', done: '完成', draft: '草稿', merged: '已合并', closed: '已关闭' } as const

/** A thread's own page, pushed from a thread card or the 线程 list; back returns (mobile.md). */
export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const thread = threads.find(t => t.id === id) ?? threads[1]
  const steps = threadSteps[thread.id] ?? { done: ['读取任务说明', '查看相关代码'], reply: thread.status === 'done' ? '做完了，结果在上面。' : '在处理，有进展会在这里更新。' }
  const [sent, setSent] = useState<string[]>([])
  const machine = machines.find(m => m.id === thread.machine)?.name

  return (
    <View style={styles.screen}>
      <Header
        style={{ alignItems: 'center' }}
        left={<BackButton onPress={() => (router.canGoBack() ? router.back() : router.replace('/threads'))} />}
        title={
          <View style={styles.titleRow}>
            <StatusIcon status={thread.status} size={18} />
            <View style={{ flexShrink: 1 }}>
              <Text style={styles.title} numberOfLines={1}>{thread.title}</Text>
              <Text style={styles.subtitle} numberOfLines={1}>{STATUS_WORD[thread.status]} · {thread.bot} · {thread.harness} · {machine}</Text>
            </View>
          </View>
        }
        right={<View />}
      />
      <ScrollView contentContainerStyle={[styles.body, { paddingBottom: 24 }]}>
        {steps.done.map(step => (
          <View key={step} style={styles.step}>
            <Check size={15} color={colors.secondary} strokeWidth={2.2} />
            <Text style={styles.stepText}>{step}</Text>
          </View>
        ))}
        {steps.reply ? <View style={{ marginVertical: 6 }}><BotBubble><Text style={styles.reply}>{steps.reply}</Text></BotBubble></View> : null}
        {steps.running && thread.status === 'running' ? (
          <View style={styles.step}>
            <Spinner size={14} />
            <Text style={[styles.stepText, { fontSize: 13 }]}>{steps.running}</Text>
          </View>
        ) : null}
        {sent.map((text, i) => <View key={i} style={{ marginTop: 8 }}><MyBubble text={text} /></View>)}
      </ScrollView>
      <Composer placeholder="给这个线程发消息" onSend={text => setSent(list => [...list, text])} />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'stretch', marginLeft: -8, marginRight: -60 },
  title: { fontSize: 16, fontWeight: '600' },
  subtitle: { fontSize: 11, color: colors.secondary, marginTop: 1 },
  body: { paddingHorizontal: 16, paddingTop: 8, gap: 4 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 26 },
  stepText: { fontSize: 14, color: colors.secondary },
  reply: { fontSize: 16, lineHeight: 25 },
})
