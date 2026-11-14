import { conversationAccessDenied, useConversationDelivery } from '@/features/chat/components/conversation-delivery'
import { mobileMessages } from '@/lib/messages'
import { useCallback, useRef, useState, type ReactNode } from 'react'
import { Platform, Pressable, StyleSheet, View } from 'react-native'
import { KeyboardChatScrollView } from 'react-native-keyboard-controller'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronDown, ChevronRight, ScanSearch } from 'lucide-react-native'
import { BotBubble, MyBubble } from '@/components/chat'
import { Spinner } from '@/components/icons'
import { Markdown } from '@/components/Markdown'
import { NavBar, underBar } from '@/components/NavBar'
import { useScrolledUnderBar } from '@/components/BarBackdrop'
import { ThreadSteps } from '@/features/tasks/components/thread-steps'
import { AgentName } from '@/features/tasks/components/agent-name'
import { OfflineBanner } from '@/components/OfflineBanner'
import { ReadNotice } from '@/components/ReadNotice'
import { StopFailed } from '@/components/StopFailed'
import { Text } from '@/components/Text'
import { ThreadQuotaPaused } from '@/components/ThreadQuotaPaused'
import { ThreadComposer } from '@/features/chat/components/thread-composer'
import { api, ApiError } from '@/lib/api'
import { useHome } from '@/lib/home'
import { tasksLive, threadLive } from '@/lib/live-keys'
import { composerStops } from '@/lib/stop'
import { runErrorLine } from '@/lib/run-error'
import type { TaskDetail, ThreadDetail, ThreadItem } from '@/lib/types'
import { useLiveApi } from '@/lib/useApi'
import { useStop } from '@/lib/useStop'
import { colors } from '@/lib/theme'
import { boundary, conversationReplyRun, conversationSegments, currentAgent, reviewRun, type Attempt } from '../model/task-conversation'
import { STAGE_WORD, stageLine, verdictWord, type TaskFlow } from '../model/task-flow'

type Conversation = { detail: TaskDetail; threads: Record<string, ThreadDetail> }

/** The task's detail, then each attempt's thread: one read per attempt with the existing routes, no new API. */
async function readConversation(id: string): Promise<Conversation> {
  const detail = await api<TaskDetail>(`/api/mobile/tasks/${id}`)
  const attempts = detail.activity.filter((item): item is Attempt => item.kind === 'attempt')
  const threads = await Promise.all(attempts.map(attempt => api<ThreadDetail>(`/api/mobile/threads/${attempt.runId}`)))
  return { detail, threads: Object.fromEntries(attempts.map((attempt, index) => [attempt.runId, threads[index]!])) }
}

/**
 * A task's one conversation (Alex 2026-11-07, 2026-11-08): every run's messages in order, oldest at the top. A line
 * only where the task switched Agent (the next Agent's glyph and name, no verb); a small marker
 * where a factory stage started (「独立审查」); same-Agent runs otherwise read as one. The bar is ← and the task's title over the current
 * Agent; the composer, 停止 and quota pause use the authorized conversation head. It updates on the task's and the newest
 * attempt's live keys.
 */
export function TaskConversationScreen() {
  const { id, attempt } = useLocalSearchParams<{ id: string; attempt?: string }>()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const bar = useScrolledUnderBar()
  const home = useHome().data
  // Stable: useLiveApi reads again whenever its reader changes.
  const read = useCallback(() => readConversation(id), [id])
  const { data, error, reload } = useLiveApi<Conversation>(`/api/mobile/tasks/${id}/conversation`, current => {
    const tasks = tasksLive(home?.live?.workspaceId, home?.workspace.id)
    const newest = current && conversationReplyRun(current.detail.task, current.detail.activity)
    const thread = newest ? threadLive(current?.threads[newest] ?? null, newest) : null
    return { minIntervalMs: tasks.minIntervalMs, refs: [...tasks.refs, ...(thread?.refs ?? [])] }
  }, read)
  const segments = data ? conversationSegments(data.detail.activity, new Map(Object.entries(data.threads))) : []
  const newest = data && conversationReplyRun(data.detail.task, data.detail.activity)
  const live = newest ? data?.threads[newest] ?? null : null
  const canSend = Boolean(newest && live && live.canReply !== false && !conversationAccessDenied(error))
  const delivery = useConversationDelivery(newest && canSend ? { kind: 'thread', id: newest, issueId: id } : null,
    Object.values(data?.threads ?? {}).flatMap(thread => thread.confirmedSubmissionIds ?? []), reload)
  const stopper = useStop(() => api(`/api/mobile/threads/${newest}/stop`, { method: 'POST' }).catch(failure => {
    if (!(failure instanceof ApiError && failure.status === 409)) throw failure
  }), Boolean(live?.active), reload)

  const task = data?.detail.task
  const agent = currentAgent(segments)
  // Opened on an attempt from 活动: scrolled to its part, once. Opened plainly: at the newest, at the bottom, as a chat.
  const scroller = useRef<{ scrollTo: (to: { y: number; animated: boolean }) => void; scrollToEnd: (options: { animated: boolean }) => void } | null>(null)
  const offsets = useRef(new Map<string, number>())
  const placed = useRef(false)
  const place = () => {
    if (placed.current || !segments.length) return
    const y = attempt ? offsets.current.get(attempt) : undefined
    if (attempt && y === undefined && segments.some(segment => segment.attempt.runId === attempt)) return
    placed.current = true
    if (y !== undefined) scroller.current?.scrollTo({ y: Math.max(0, y - 8), animated: false })
    else scroller.current?.scrollToEnd({ animated: false })
  }
  return (
    <View style={styles.screen}>
      <NavBar
        scrolled={bar.scrolled}
        back={() => (router.canGoBack() ? router.back() : router.replace(`/task/${id}`))}
        titleView={task ? (
          <View style={styles.titleBox}>
            <Text style={styles.title} numberOfLines={1}>{task.title}</Text>
            {agent ? <Text style={styles.subtitle} numberOfLines={1}>{agent}</Text> : null}
          </View>
        ) : undefined}
      />
      <KeyboardChatScrollView onScroll={bar.onScroll} scrollEventThrottle={16} ref={scroller as never} onContentSizeChange={place} {...underBar} offset={Math.max(insets.bottom, 12) - 8} keyboardDismissMode="interactive" keyboardLiftBehavior="whenAtEnd" contentContainerStyle={styles.body}>
        {!data && !error ? <View style={styles.center}><Spinner /></View> : null}
        <ReadNotice error={error} hasData={Boolean(data)} label={mobileMessages.Coordinator.conversation} onRetry={reload} />
        {/* A factory task's one stage, and what it needs from you (2026-11-04-2200); nothing without a flow. */}
        {stageLine(data?.detail.task.flow) ? <Text style={styles.stageLine}>{stageLine(data?.detail.task.flow)}</Text> : null}
        {data && !segments.length ? <Text style={styles.empty}>{mobileMessages.MobileCore.notStarted}</Text> : null}
        {segments.map((segment, index) => (
          <View key={segment.attempt.runId} style={styles.segment}
            onLayout={event => { offsets.current.set(segment.attempt.runId, event.nativeEvent.layout.y); place() }}>
            {index > 0 ? <Boundary at={boundary(segments[index - 1]!.attempt, segment.attempt)} /> : null}
            {reviewRun(segment.attempt)
              ? <ReviewCard flow={data?.detail.task.flow} running={data?.threads[segment.attempt.runId]?.active === true}>
                {segment.items.map((item, at) => <Item key={item.id} item={item} live={data?.threads[segment.attempt.runId]?.active === true && at === segment.items.length - 1} />)}
              </ReviewCard>
              : segment.items.map((item, at) => <Item key={item.id} item={item} live={data?.threads[segment.attempt.runId]?.active === true && at === segment.items.length - 1} />)}
            {/* A failed attempt's cause stays inside it, in words, with the raw code under 详情 (2026-11-05-0330). */}
            {segment.error && !(data?.threads[segment.attempt.runId]?.active) && !segment.items.some(item => item.kind === 'error') ? <AttemptError raw={segment.error} /> : null}
          </View>
        ))}
        {delivery.bubbles}
        {live?.paused ? <ThreadQuotaPaused key={live.paused.runId} paused={live.paused} onContinued={() => reload()} /> : null}
        {stopper.stuck ? <StopFailed busy={stopper.sending} onRetry={() => void stopper.stop()} /> : null}
      </KeyboardChatScrollView>
      <OfflineBanner top={insets.top + 66} />
      {/* R-10: the conversation ends in the composer; a message to an ended attempt runs it again (R-81). */}
      {live && newest ? <ThreadComposer detail={live} runId={newest} placeholder={mobileMessages.MobileCore.messageTask} onSend={(text, choice) => delivery.send(text, [], choice)} sendDisabled={!canSend} attach attachmentScope={{ kind: 'thread', id: newest }}
        onStop={composerStops(live) && !stopper.sending ? () => void stopper.stop() : undefined} /> : null}
    </View>
  )
}

function Item({ item, live }: { item: ThreadItem; live: boolean }) {
  switch (item.kind) {
    case 'steps':
      return <ThreadSteps steps={item.steps} count={item.count} live={live} />
    case 'agent': return <View style={styles.message}><BotBubble><Markdown text={item.text} /></BotBubble></View>
    case 'error': return <AttemptError raw={item.text} />
    case 'person': return <View style={styles.message}><MyBubble text={item.text} threadReferences /></View>
  }
}

/** Why an attempt stopped: its code's words in secondary text, the raw error folded under 详情. Never raw red text. */
function AttemptError({ raw }: { raw: string }) {
  const [open, setOpen] = useState(false)
  const { line } = runErrorLine(raw)
  return (
    <View style={styles.cause}>
      <Text style={styles.causeLine}>{line}</Text>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(value => !value)} hitSlop={8}>
        <Text style={styles.detailsToggle}>{mobileMessages.IssueThreads.errorDetails}</Text>
      </Pressable>
      {open ? <Text selectable style={styles.details}>{raw}</Text> : null}
    </View>
  )
}

/**
 * The factory's review, run once per task (2026-11-04-2200), as one result card rather than its full text: 「审阅」
 * and its verdict (通过 / 需要修改 / 需要你判断, from the task's flow), which opens to the reviewer's transcript.
 */
function ReviewCard({ flow, running, children }: { flow: TaskFlow | null | undefined; running: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const verdict = running ? mobileMessages.MobileCore.groups.running : verdictWord(flow)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <View style={styles.review}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={[STAGE_WORD.review, verdict].filter(Boolean).join(' · ')}
        onPress={() => setOpen(value => !value)} style={({ pressed }) => [styles.reviewHead, pressed && { opacity: 0.6 }]}>
        {running ? <Spinner size={16} /> : <ScanSearch size={18} color={flow?.review?.verdict === 'passed' ? colors.success : flow?.review?.verdict ? colors.orange : colors.secondary} strokeWidth={2} />}
        <Text style={styles.reviewTitle}>{STAGE_WORD.review}</Text>
        {verdict ? <Text style={[styles.reviewVerdict, flow?.review?.verdict === 'passed' ? { color: colors.success } : flow?.review?.verdict ? { color: colors.orange } : null]}>{verdict}</Text> : null}
        <View style={{ flex: 1 }} />
        <Chevron size={16} color={colors.tertiary} strokeWidth={2.2} />
      </Pressable>
      {open ? <View style={styles.reviewBody}>{children}</View> : null}
    </View>
  )
}

/**
 * Between two runs of the task's one conversation: where the Agent changed, the next Agent (glyph and name) between hairlines,
 * a small marker where a factory stage started (「独立审查」), nothing otherwise.
 */
function Boundary({ at }: { at: ReturnType<typeof boundary> }) {
  if (!at) return null
  return at.kind === 'agent' ? <Divider harness={at.harness} /> : <Text style={styles.stage}>{at.text}</Text>
}

/** Where the Agent changed, as the chat's event lines are drawn: the next Agent, centred between hairlines; no verb. */
function Divider({ harness }: { harness: string }) {
  return (
    <View style={styles.divider} accessibilityRole="header">
      <View style={styles.rule} />
      <AgentName harness={harness} size={13} style={styles.dividerText} />
      <View style={styles.rule} />
    </View>
  )
}

const styles = StyleSheet.create({
  stageLine: { alignSelf: 'center', fontSize: 13, fontWeight: '600', color: colors.secondary, marginBottom: 4 },
  review: { borderRadius: 18, borderCurve: 'continuous', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separator, paddingHorizontal: 14, paddingVertical: 4 },
  reviewHead: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  reviewTitle: { fontSize: 16, fontWeight: '600', color: colors.text },
  reviewVerdict: { fontSize: 15, color: colors.secondary },
  reviewBody: { gap: 12, paddingBottom: 10 },
  stage: { alignSelf: 'center', fontSize: 12, fontWeight: '500', color: colors.secondary, paddingHorizontal: 10, paddingVertical: 3, marginVertical: 4 },
  screen: { flex: 1, backgroundColor: colors.page },
  titleBox: { alignItems: 'center', maxWidth: 260 },
  title: { fontSize: 16, fontWeight: '600' },
  subtitle: { fontSize: 11, color: colors.secondary, marginTop: 1 },
  body: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24, gap: 4 },
  center: { paddingTop: 40, alignItems: 'center' },
  empty: { paddingTop: 40, textAlign: 'center', fontSize: 15, color: colors.secondary },
  message: { marginVertical: 4 },
  error: { fontSize: 14, color: colors.danger, marginVertical: 4 },
  segment: { gap: 4 },
  cause: { gap: 4, marginVertical: 4 },
  causeLine: { fontSize: 14, color: colors.secondary },
  detailsToggle: { fontSize: 12, color: colors.secondary, textDecorationLine: 'underline' },
  details: { fontSize: 12, color: colors.secondary, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 14 },
  rule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.separator },
  dividerText: { flexShrink: 1, fontSize: 13, color: colors.secondary },
})
