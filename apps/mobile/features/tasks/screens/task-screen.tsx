import { useEffect, useRef, type ReactNode } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { useLocalSearchParams, useRouter, type Href } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { CalendarClock, ChevronRight, Sparkles } from 'lucide-react-native'
import { BotAvatar, MachineIcon, Spinner } from '@/components/icons'
import { Markdown } from '@/components/Markdown'
import { NavBar, underBar } from '@/components/NavBar'
import { ReadNotice } from '@/components/ReadNotice'
import { Text } from '@/components/Text'
import { GlassButton } from '@/components/GlassButton'
import { HARNESS } from '@/lib/harness'
import { useHome } from '@/lib/home'
import { tasksLive } from '@/lib/live-keys'
import type { TaskActivity, TaskDetail } from '@/lib/types'
import { useLiveApi } from '@/lib/useApi'
import { openOnWeb } from '@/lib/web'
import { colors, LIST_INSET } from '@/lib/theme'
import { BOARD_LABEL, PriorityIcon, priorityLabel, STATE_LABEL, TaskStateIcon } from '../components/task-icons'
import { ATTEMPT_WORD, attemptState, rowState } from '../model/task-groups'

const day = (iso: string) => {
  const d = new Date(iso)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/** Where an attempt opens: its thread, titled 「第 N 次尝试 · Agent」 over the task's name. */
export const attemptHref = (attempt: Extract<TaskActivity, { kind: 'attempt' }>, task: { title: string; identifier: string | null }): Href =>
  ({ pathname: '/thread/[id]', params: { id: attempt.runId, n: String(attempt.n), agent: HARNESS[attempt.harness] ?? attempt.harness, task: [task.identifier, task.title].filter(Boolean).join(' ') } })

/**
 * A task's detail (decisions/2026-11-07-2045-tasks-only-threads-inside.md, Figma 1085:2 M2): its number and title,
 * its properties in one grey box, its description, then 活动 (each attempt, a replaced thread, its creation), newest
 * first. An attempt opens that thread pushed over the task; a push about a waiting thread lands here with `attempt`
 * and opens it once. 「+ 评论」 floats at the foot.
 */
export function TaskScreen() {
  const { id, attempt } = useLocalSearchParams<{ id: string; attempt?: string }>()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const home = useHome().data
  const { data, error, loading, reload } = useLiveApi<TaskDetail>(`/api/mobile/tasks/${id}`, () => tasksLive(home?.live?.workspaceId, home?.workspace.id))
  const task = data?.task
  // The task's own state: its current attempt's in 等待你 and 进行中, else its board status (2026-11-07-2230).
  const shown = task ? rowState(task) : null
  // The newest attempt is the task's current one: it says the task's reason (待审阅 · Claude Code · date).
  const currentAttempt = data?.activity.find(item => item.kind === 'attempt')?.runId

  // A push opens the task, then the attempt it was about, once.
  const opened = useRef(false)
  useEffect(() => {
    if (opened.current || !attempt || !data) return
    opened.current = true
    const found = data.activity.find((item): item is Extract<TaskActivity, { kind: 'attempt' }> => item.kind === 'attempt' && item.runId === attempt)
    router.push(found ? attemptHref(found, data.task) : `/thread/${attempt}`)
  }, [attempt, data, router])

  return (
    <View style={styles.screen}>
      <NavBar />
      <ScrollView {...underBar} contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 96 }]}>
        <ReadNotice error={error} hasData={Boolean(data)} label="任务" onRetry={reload} />
        {loading && !data ? <View style={styles.center}><Spinner /></View> : null}
        {task ? (
          <>
            {task.identifier ? <Text style={styles.key} selectable>{task.identifier}</Text> : null}
            <Text accessibilityRole="header" style={styles.title} selectable>{task.title}</Text>
            <View style={styles.properties}>
              <Chip icon={<TaskStateIcon state={shown?.state ?? null} status={task.status} size={15} />}
                label={shown?.reason ?? (shown?.state === 'waiting' ? '等待你' : shown?.state ? STATE_LABEL[shown.state] : BOARD_LABEL[task.status] ?? task.status)} />
              <Chip icon={<PriorityIcon priority={task.priority} size={15} />} label={`${priorityLabel(task.priority)}优先级`} />
              {task.bot ? <Chip icon={<BotAvatar color={task.bot.color} shape={task.bot.shape} size={16} />} label={task.bot.name} /> : null}
              {task.agent ? <Chip icon={<Sparkles size={14} color={colors.secondary} strokeWidth={2} />} label={[HARNESS[task.agent.harness] ?? task.agent.harness, task.agent.model].filter(Boolean).join(' · ')} /> : null}
              {task.place ? <Chip icon={<MachineIcon machine={task.place.kind} size={15} />} label={task.place.name} /> : null}
              {task.schedule ? <Chip icon={<CalendarClock size={14} color={colors.secondary} strokeWidth={2} />} label={task.schedule.label} /> : null}
            </View>
            {task.description ? <View style={styles.description}><Markdown text={task.description} /></View> : null}
            {data.activity.length ? <Text accessibilityRole="header" style={styles.section}>活动</Text> : null}
            {data.activity.map((item, index) => <ActivityRow key={`${item.kind}:${index}`} item={item} last={index === data.activity.length - 1}
              reason={item.kind === 'attempt' && item.runId === currentAttempt ? shown?.reason ?? null : null}
              onOpen={item.kind === 'attempt' ? () => router.push(attemptHref(item, task)) : undefined} />)}
          </>
        ) : null}
      </ScrollView>
      {task ? (
        <View pointerEvents="box-none" style={[styles.commentWrap, { bottom: insets.bottom + 12 }]}>
          {/* Comments are written on the web for now: the app has no comment route yet (#1671). */}
          <GlassButton label="+ 评论" onPress={() => void openOnWeb(`/?issue=${task.id}`)} />
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
 * One entry of 活动 on the timeline: an attempt carries its own result's icon and word (2026-11-07-2230) and opens
 * its thread; a replaced thread and the creation are lines.
 */
function ActivityRow({ item, last, reason, onOpen }: { item: TaskActivity; last: boolean; reason: string | null; onOpen?: () => void }) {
  const result = item.kind === 'attempt' ? attemptState(item) : null
  const body = (
    <>
      <View style={styles.rail}>
        <View style={styles.node} />
        {last ? null : <View style={styles.line} />}
      </View>
      {result ? <TaskStateIcon state={result === 'done' || result === 'todo' ? null : result} status={result === 'done' ? 'done' : 'todo'} size={20} /> : <View style={styles.noBot} />}
      <View style={styles.activityText}>
        <Text style={styles.activityTitle} numberOfLines={1}>
          {item.kind === 'attempt' ? `第 ${item.n} 次尝试` : item.kind === 'replaced' ? '换了新线程' : item.by ? `${item.by} 创建了任务` : '创建了任务'}
        </Text>
        <Text style={styles.activityMeta} numberOfLines={1}>
          {result && item.kind === 'attempt' ? [result === 'failed' ? ATTEMPT_WORD.failed : reason ?? ATTEMPT_WORD[result], HARNESS[item.harness] ?? item.harness, day(item.createdAt)].filter(Boolean).join(' · ') : day(item.createdAt)}
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
  title: { fontSize: 26, lineHeight: 32, fontWeight: '700', color: colors.text, marginTop: 4, marginBottom: 14 },
  properties: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 10, borderRadius: 14, borderCurve: 'continuous', backgroundColor: colors.bubble },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '100%', minHeight: 30, paddingHorizontal: 10, borderRadius: 8, borderCurve: 'continuous', backgroundColor: colors.chip },
  chipText: { flexShrink: 1, fontSize: 14, color: colors.text },
  description: { marginTop: 16 },
  section: { marginTop: 28, marginBottom: 6, fontSize: 14, fontWeight: '600', color: colors.secondary },
  activity: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 58, marginHorizontal: -8, paddingHorizontal: 8, borderRadius: 10, borderCurve: 'continuous' },
  rail: { width: 10, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
  node: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.tertiary },
  line: { position: 'absolute', top: '50%', bottom: -29, width: 1.5, backgroundColor: colors.separator },
  noBot: { width: 20 },
  activityText: { flex: 1, minWidth: 0, gap: 2 },
  activityTitle: { fontSize: 16, fontWeight: '500', color: colors.text },
  activityMeta: { fontSize: 13, color: colors.secondary },
  commentWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
})
