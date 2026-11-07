import { Fragment, useCallback, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { KeyboardChatScrollView } from 'react-native-keyboard-controller'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Check } from 'lucide-react-native'
import { BotBubble, MyBubble } from '@/components/chat'
import { Spinner } from '@/components/icons'
import { Markdown } from '@/components/Markdown'
import { NavBar, underBar } from '@/components/NavBar'
import { OfflineBanner } from '@/components/OfflineBanner'
import { ReadNotice } from '@/components/ReadNotice'
import { StopFailed } from '@/components/StopFailed'
import { Text } from '@/components/Text'
import { ThreadQuotaPaused } from '@/components/ThreadQuotaPaused'
import { Composer } from '@/features/chat/components/chat-composer'
import { api, ApiError } from '@/lib/api'
import { useHome } from '@/lib/home'
import { tasksLive, threadLive } from '@/lib/live-keys'
import { composerStops } from '@/lib/stop'
import { threadSendErrorLine } from '@/lib/thread-send-error'
import type { TaskDetail, ThreadDetail, ThreadItem } from '@/lib/types'
import { useLiveApi } from '@/lib/useApi'
import { useStop } from '@/lib/useStop'
import { colors } from '@/lib/theme'
import { conversationSegments, currentAgent, dividerText, type Attempt } from '../model/task-conversation'

type Conversation = { detail: TaskDetail; threads: Record<string, ThreadDetail> }

/** The task's detail, then each attempt's thread: one read per attempt with the existing routes, no new API. */
async function readConversation(id: string): Promise<Conversation> {
  const detail = await api<TaskDetail>(`/api/mobile/tasks/${id}`)
  const attempts = detail.activity.filter((item): item is Attempt => item.kind === 'attempt')
  const threads = await Promise.all(attempts.map(attempt => api<ThreadDetail>(`/api/mobile/threads/${attempt.runId}`)))
  return { detail, threads: Object.fromEntries(attempts.map((attempt, index) => [attempt.runId, threads[index]!])) }
}

/**
 * A task's one conversation (Alex 2026-11-07): every attempt's messages in order, oldest at the top, with a line
 * between attempts (「第 1 次尝试失败 · 换 Claude Code 再试」). The bar is ← and the task's title over the current
 * Agent; the composer, 停止 and a quota pause act on the newest attempt. It updates on the task's and the newest
 * attempt's live keys.
 */
export function TaskConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string; attempt?: string }>()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const home = useHome().data
  // Stable: useLiveApi reads again whenever its reader changes.
  const read = useCallback(() => readConversation(id), [id])
  const { data, error, reload } = useLiveApi<Conversation>(`/api/mobile/tasks/${id}/conversation`, current => {
    const tasks = tasksLive(home?.live?.workspaceId, home?.workspace.id)
    const newest = current ? conversationSegments(current.detail.activity, new Map()).at(-1)?.attempt.runId : undefined
    const thread = newest ? threadLive(current?.threads[newest] ?? null, newest) : null
    return { minIntervalMs: tasks.minIntervalMs, refs: [...tasks.refs, ...(thread?.refs ?? [])] }
  }, read)
  const segments = data ? conversationSegments(data.detail.activity, new Map(Object.entries(data.threads))) : []
  const newest = segments.at(-1)?.attempt.runId ?? null
  const live = newest ? data?.threads[newest] ?? null : null
  const [sending, setSending] = useState(false)
  const [sendFailed, setSendFailed] = useState<string | null>(null)
  const stopper = useStop(() => api(`/api/mobile/threads/${newest}/stop`, { method: 'POST' }).catch(failure => {
    if (!(failure instanceof ApiError && failure.status === 409)) throw failure
  }), Boolean(live?.active), reload)

  const send = async (text: string) => {
    if (!newest) return false
    setSending(true)
    setSendFailed(null)
    try {
      await api(`/api/mobile/threads/${newest}`, { method: 'POST', body: { text } })
      await reload()
      return true
    } catch (failure) {
      setSendFailed(threadSendErrorLine(failure instanceof ApiError && failure.status < 500 ? failure.code : null))
      return false
    } finally {
      setSending(false)
    }
  }

  const task = data?.detail.task
  const agent = currentAgent(segments)
  return (
    <View style={styles.screen}>
      <NavBar
        back={() => (router.canGoBack() ? router.back() : router.replace(`/task/${id}`))}
        titleView={task ? (
          <View style={styles.titleBox}>
            <Text style={styles.title} numberOfLines={1}>{task.title}</Text>
            {agent ? <Text style={styles.subtitle} numberOfLines={1}>{agent}</Text> : null}
          </View>
        ) : undefined}
      />
      <KeyboardChatScrollView {...underBar} offset={Math.max(insets.bottom, 12) - 8} keyboardDismissMode="interactive" keyboardLiftBehavior="whenAtEnd" contentContainerStyle={styles.body}>
        {!data && !error ? <View style={styles.center}><Spinner /></View> : null}
        <ReadNotice error={error} hasData={Boolean(data)} label="对话" onRetry={reload} />
        {data && !segments.length ? <Text style={styles.empty}>还没有尝试</Text> : null}
        {segments.map((segment, index) => (
          <Fragment key={segment.attempt.runId}>
            {index > 0 ? <Divider text={dividerText(segments[index - 1]!.attempt, segment.attempt)} /> : null}
            {segment.items.map((item, at) => <Item key={item.id} item={item} live={Boolean(live?.active) && index === segments.length - 1 && at === segment.items.length - 1} />)}
            {/* A failed attempt's raw error stays inside it (2026-11-05-0330). */}
            {segment.error && !(index === segments.length - 1 && live?.active) && !segment.items.some(item => item.kind === 'error') ? <Text style={styles.error}>{segment.error}</Text> : null}
          </Fragment>
        ))}
        {sendFailed ? <Text style={styles.error}>{sendFailed}</Text> : null}
        {live?.paused ? <ThreadQuotaPaused key={live.paused.runId} paused={live.paused} onContinued={() => reload()} /> : null}
        {stopper.stuck ? <StopFailed busy={stopper.sending} onRetry={() => void stopper.stop()} /> : null}
      </KeyboardChatScrollView>
      <OfflineBanner top={insets.top + 66} />
      {/* R-10: the conversation ends in the composer; a message to an ended attempt runs it again (R-81). */}
      {live && newest ? <Composer placeholder="给这个任务发消息" onSend={send} disabled={sending} attach attachmentScope={{ kind: 'thread', id: newest }}
        onStop={composerStops(live) && !stopper.sending ? () => void stopper.stop() : undefined} /> : null}
    </View>
  )
}

function Item({ item, live }: { item: ThreadItem; live: boolean }) {
  switch (item.kind) {
    case 'steps':
      return (
        <View style={styles.step}>
          {live ? <Spinner size={14} /> : <Check size={15} color={colors.secondary} strokeWidth={2.2} />}
          <Text style={styles.stepText}>{item.count} 步</Text>
        </View>
      )
    case 'agent': return <View style={styles.message}><BotBubble><Markdown text={item.text} /></BotBubble></View>
    case 'error': return <Text style={styles.error}>{item.text}</Text>
    case 'person': return <View style={styles.message}><MyBubble text={item.text} /></View>
  }
}

/** The line between two attempts, as the chat's event lines are drawn: centred grey words between hairlines. */
function Divider({ text }: { text: string }) {
  return (
    <View style={styles.divider} accessibilityRole="header">
      <View style={styles.rule} />
      <Text style={styles.dividerText} numberOfLines={1}>{text}</Text>
      <View style={styles.rule} />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  titleBox: { alignItems: 'center', maxWidth: 260 },
  title: { fontSize: 16, fontWeight: '600' },
  subtitle: { fontSize: 11, color: colors.secondary, marginTop: 1 },
  body: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24, gap: 4 },
  center: { paddingTop: 40, alignItems: 'center' },
  empty: { paddingTop: 40, textAlign: 'center', fontSize: 15, color: colors.secondary },
  message: { marginVertical: 4 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 26 },
  stepText: { fontSize: 14, color: colors.secondary },
  error: { fontSize: 14, color: colors.danger, marginVertical: 4 },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 14 },
  rule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.separator },
  dividerText: { flexShrink: 1, fontSize: 13, color: colors.secondary },
})
