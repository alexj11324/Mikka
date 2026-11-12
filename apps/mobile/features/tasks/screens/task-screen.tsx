import { presentedFactoryEvents, taskEvidenceHref } from '../../../../../lib/task-factory-events'
import { mobileMessages } from '@/lib/messages'
import { useEffect, useRef, type ReactNode } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { useLocalSearchParams, useRouter, type Href } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { CalendarClock, ChevronRight, Sparkles } from 'lucide-react-native'
import { BotAvatar, MachineIcon, Spinner } from '@/components/icons'
import { Markdown } from '@/components/Markdown'
import { NavBar, underBar } from '@/components/NavBar'
import { useScrolledUnderBar } from '@/components/BarBackdrop'
import { ReadNotice } from '@/components/ReadNotice'
import { Text } from '@/components/Text'
import { GlassButton } from '@/components/GlassButton'
import { HARNESS } from '@/lib/harness'
import { useHome } from '@/lib/home'
import { taskDetailLive } from '@/lib/live-keys'
import { readPresentedTask } from '../model/task-presentation-read'
import type { TaskActivity, TaskDetail } from '@/lib/types'
import { useLiveApi } from '@/lib/useApi'
import { openOnWeb } from '@/lib/web'
import { shortWhen } from '@/lib/clock'
import { colors, LIST_INSET, SPACE } from '@/lib/theme'
import { AttemptIcon, BOARD_LABEL, PriorityIcon, priorityLabel, STATE_LABEL, TaskStateIcon } from '../components/task-icons'
import { ATTEMPT_WORD, attemptState, rowState } from '../model/task-groups'
import { activityEntries, activityEntryId, nativeActivityLabel, type ActivityEntry } from '../model/task-conversation'
import { AgentName } from '../components/agent-name'
import { ReviewSummaryRow } from '@/features/review/components/review-summary-row'
import { reviewHref } from '@/features/review/model/routes'


/** Where an attempt opens: the task's one conversation, scrolled to that attempt (2026-11-07). */
export const conversationHref = (taskId: string, attempt?: string): Href => ({ pathname: '/task/[id]/conversation', params: attempt ? { id: taskId, attempt } : { id: taskId } })

/**
 * A task's detail (decisions/2026-11-07-2045-tasks-only-threads-inside.md, Figma 1085:2 M2): its number and title,
 * its properties in one grey box, its description, then 活动 oldest first (its creation, each attempt with its own
 * result, a replaced thread). An attempt opens the task's one conversation; a push about a waiting thread lands here
 * with `attempt` and opens it once. 「+ 评论」 floats at the foot.
 */
export function TaskScreen() {
  const { id, attempt } = useLocalSearchParams<{ id: string; attempt?: string }>()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const bar = useScrolledUnderBar()
  const home = useHome().data
  const { data, error, loading, reload } = useLiveApi<TaskDetail>(`/api/mobile/tasks/${id}`,
    detail => taskDetailLive(id, detail?.live?.workspaceId, home?.live?.workspaceId, home?.workspace.id, detail?.task.factoryTaskId, detail?.live?.factoryActivityVersion), readPresentedTask)
  const task = data?.task
  // The task's own state: its current attempt's in 等待你 and 进行中, else its board status (2026-11-07-2230).
  const shown = task ? rowState(task) : null
  // 活动 runs oldest first, from the task's creation down (Alex 2026-11-07); the server sends it newest first.
  const receipts = presentedFactoryEvents(data?.factoryEvents, task?.factoryTaskId)
  const activity = data ? activityEntries(data.activity, [...data.timeline ?? [], ...receipts]) : []

  // A push opens the task, then the attempt it was about, once.
  const opened = useRef(false)
  useEffect(() => {
    if (opened.current || !attempt || !data) return
    opened.current = true
    const found = data.activity.some(item => item.kind === 'attempt' && item.runId === attempt)
    router.push(found ? conversationHref(data.task.id, attempt) : `/thread/${attempt}`)
  }, [attempt, data, router])

  return (
    <View style={styles.screen}>
      <NavBar scrolled={bar.scrolled} />
      <ScrollView {...underBar} onScroll={bar.onScroll} scrollEventThrottle={16} contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 96 }]}>
        <ReadNotice error={error} hasData={Boolean(data)} label={mobileMessages.Nav.tasks} onRetry={reload} />
        {loading && !data ? <View style={styles.center}><Spinner /></View> : null}
        {task ? (
          <>
            {task.identifier ? <Text style={styles.key} selectable>{task.identifier}</Text> : null}
            <Text accessibilityRole="header" style={styles.title} selectable>{task.title}</Text>
            {/* A code task's first row is its review summary; one tap opens the review (R2a, decisions/2026-11-08-1230). */}
            {task.review ? <View style={styles.review}><ReviewSummaryRow short summary={task.review} onPress={() => router.push(reviewHref(task.id))} /></View> : null}
            <View style={styles.properties}>
              <Chip icon={<TaskStateIcon state={shown?.state ?? null} status={task.status} size={15} />}
                label={shown?.reason ?? (shown?.state === 'waiting' ? mobileMessages.MobileCore.groups.pending : shown?.state ? STATE_LABEL[shown.state] : BOARD_LABEL[task.status] ?? task.status)} />
              <Chip icon={<PriorityIcon priority={task.priority} size={15} />} label={mobileMessages.MobileCore.priority.replace('{priority}', priorityLabel(task.priority))} />
              {task.bot ? <Chip icon={<BotAvatar id={task.bot.id} color={task.bot.color} shape={task.bot.shape} size={16} />} label={task.bot.name} /> : null}
              {task.agent ? <Chip icon={<Sparkles size={14} color={colors.secondary} strokeWidth={2} />} label={[HARNESS[task.agent.harness] ?? task.agent.harness, task.agent.model].filter(Boolean).join(' · ')} /> : null}
              {task.place ? <Chip icon={<MachineIcon machine={task.place.kind} size={15} />} label={task.place.name} /> : null}
              {task.schedule ? <Chip icon={<CalendarClock size={14} color={colors.secondary} strokeWidth={2} />} label={task.schedule.label} /> : null}
            </View>
            {task.description ? <View style={styles.description}><Markdown text={task.description} /></View> : null}
            {activity.length ? <Text accessibilityRole="header" style={styles.section}>{mobileMessages.MobileCore.activity}</Text> : null}
            {activity.map((item, index) => <ActivityRow key={activityEntryId(item)} item={item} first={index === 0} last={index === activity.length - 1}

              onOpen={item.kind === 'agent' ? () => router.push(conversationHref(task.id, item.run.attempts[0]!.runId))
                : item.kind === 'evidence' ? () => { const href = taskEvidenceHref(task.id, item.factoryTaskId, item.sourceId); if (href) void openOnWeb(href) } : undefined} />)}
          </>
        ) : null}
      </ScrollView>
      {task ? (
        <View pointerEvents="box-none" style={[styles.commentWrap, { bottom: insets.bottom + 12 }]}>
          {/* Comments are written on the web for now: the app has no comment route yet (#1671). */}
          <GlassButton label={mobileMessages.MobileCore.comment} onPress={() => void openOnWeb(`/?issue=${task.id}`)} />
        </View>
      ) : null}
    </View>
  )
}

function Chip({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <View style={styles.chip}>
      {icon}
      <Text style={styles.chipText} numberOfLines={1}>{label}</Text>
    </View>
  )
}

/**
 * One entry of 活动 on the timeline (Alex 2026-11-08: a task is one conversation). An Agent's runs in a row are one
 * row: the Agent's glyph and name, 「Codex」, with its latest run's result (2026-11-07-2230) and date; another Agent starts
 * its own row, with no 「换」 (2026-11-09, as Warp). A row opens the task's conversation at its first run; a replaced thread and the creation are lines.
 */
function ActivityRow({ item, first, last, onOpen }: { item: ActivityEntry; first: boolean; last: boolean; onOpen?: () => void }) {
  const latest = item.kind === 'agent' ? item.run.attempts.at(-1)! : null
  // Its own run's result, never the task's reason: a run that finished and opened a PR is 完成; only the task waits.
  const result = latest ? attemptState(latest) : null
  const pullRequest = item.kind === 'agent' ? [...item.run.attempts].reverse().find(attempt => attempt.pullRequest)?.pullRequest : null
  const body = (
    <>
      {/* The timeline: each item draws the line through its own height (none above the first, none below the last), so
          it runs on unbroken whatever the items' heights. An attempt's node is its own result's icon (never the
          task's hand); the creation and a replaced thread are a small grey dot. The node's page fill hides the line. */}
      <View style={styles.rail}>
        {first ? null : <View style={[styles.line, styles.lineAbove]} />}
        {last ? null : <View style={[styles.line, styles.lineBelow]} />}
        {result ? <View style={styles.node}><AttemptIcon result={result} size={20} /></View> : <View style={styles.dot} />}
      </View>
      <View style={styles.activityText}>
        {item.kind === 'agent' ? <AgentName harness={item.run.harness} style={styles.activityTitle} /> : <Text style={styles.activityTitle} numberOfLines={1}>
          {'at' in item ? nativeActivityLabel(item) : item.kind === 'replaced' ? mobileMessages.MobileCore.threadReplaced : item.by ? mobileMessages.MobileCore.taskCreatedBy.replace('{name}', item.by) : mobileMessages.MobileCore.taskCreated}
        </Text>}
        <Text style={styles.activityMeta} numberOfLines={2}>
          {result && latest ? [ATTEMPT_WORD[result], result === 'done' && pullRequest ? mobileMessages.MobileCore.openedPullRequest.replace('{number}', String(pullRequest.number)) : null, shortWhen(latest.createdAt)].filter(Boolean).join(' · ') : item.kind === 'agent' ? null : shortWhen('at' in item ? item.at : item.createdAt)}
        </Text>
      </View>
      {onOpen ? <ChevronRight size={18} color={colors.tertiary} strokeWidth={2} /> : null}
    </>
  )
  return onOpen
    ? <Pressable accessibilityRole="link" onPress={onOpen} style={({ pressed }) => [styles.activity, pressed && { backgroundColor: colors.pressed }]}>{body}</Pressable>
    : <View style={styles.activity}>{body}</View>
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  body: { paddingHorizontal: LIST_INSET, paddingTop: 8, gap: 0 },
  center: { paddingTop: 40, alignItems: 'center' },
  key: { fontSize: 15, color: colors.secondary, fontVariant: ['tabular-nums'] },
  title: { fontSize: 26, lineHeight: 32, fontWeight: '700', color: colors.text, marginTop: 4, marginBottom: SPACE.block },
  /** The chips sit on the page, wrapping; no box around them (Alex 2026-11-08: no grey slabs). */
  properties: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '100%', minHeight: 30, paddingHorizontal: 10, borderRadius: 8, borderCurve: 'continuous', backgroundColor: colors.chip },
  chipText: { flexShrink: 1, fontSize: 14, color: colors.text },
  description: { marginTop: SPACE.block },
  review: { marginTop: -SPACE.block / 2, marginBottom: SPACE.block / 2 },
  section: { marginTop: SPACE.block + 8, marginBottom: 4, fontSize: 14, fontWeight: '600', color: colors.secondary },
  activity: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 58, marginHorizontal: -8, paddingHorizontal: 8, paddingVertical: SPACE.item / 2, borderRadius: 10, borderCurve: 'continuous' },
  /** Spans the item's full height, its padding included, so the line meets the next item's. */
  rail: { width: 24, alignSelf: 'stretch', marginVertical: -SPACE.item / 2, alignItems: 'center', justifyContent: 'center' },
  node: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.page },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.tertiary },
  line: { position: 'absolute', width: 1.5, backgroundColor: colors.separator },
  lineAbove: { top: 0, bottom: '50%' },
  lineBelow: { top: '50%', bottom: 0 },
  activityText: { flex: 1, minWidth: 0, gap: 2 },
  activityTitle: { fontSize: 16, fontWeight: '500', color: colors.text },
  activityMeta: { fontSize: 13, color: colors.secondary },
  commentWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
})
