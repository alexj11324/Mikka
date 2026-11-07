import { useState } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { CalendarClock, ChevronDown, ChevronRight } from 'lucide-react-native'
import { BotAvatar, Spinner } from '@/components/icons'
import { ReadNotice } from '@/components/ReadNotice'
import { Text } from '@/components/Text'
import { underBar } from '@/components/NavBar'
import { displayTitle } from '@/lib/display-title'
import { shortWhen } from '@/lib/clock'
import type { Task, TaskGroup } from '@/lib/types'
import { useLiveApi, useRefresh } from '@/lib/useApi'
import { tasksLive } from '@/lib/live-keys'
import { useHome } from '@/lib/home'
import { tap } from '@/lib/haptics'
import { colors, LIST_INSET, ROW_SURFACE_INSET } from '@/lib/theme'
import { groupOf, taskListRows, type TaskFilter, type TaskListRow } from '../model/task-groups'
import { GROUP_LABEL, PriorityIcon, TaskGroupIcon } from './task-icons'

/** The person's tasks (GET /api/mobile/tasks), read again when a task or one of its threads changes (the live channel). */
export function useTasks(enabled = true) {
  const home = useHome().data
  return useLiveApi<{ tasks: Task[] }>(enabled ? '/api/mobile/tasks' : null, () => tasksLive(home?.live?.workspaceId, home?.workspace.id))
}

/**
 * The 任务 tab's list (decisions/2026-11-07-2045-tasks-only-threads-inside.md, Figma 1085:2 M1): 待处理 · 进行中 ·
 * 待办 · 已完成, each under a grey rounded bar with its count that folds it; 已完成 starts folded. `bot` keeps one
 * bot's tasks (its 资料 page).
 */
export function TaskList({ filter = 'all', bot, bottom = 24 }: { filter?: TaskFilter; bot?: string; bottom?: number }) {
  const insets = useSafeAreaInsets()
  const { data, error, loading, reload } = useTasks()
  const refresh = useRefresh(reload)
  const [toggled, setToggled] = useState<ReadonlySet<TaskGroup>>(new Set())
  const tasks = bot ? (data?.tasks ?? []).filter(task => task.bot?.id === bot) : data?.tasks ?? []
  const rows = taskListRows(tasks, toggled, filter)
  const toggle = (id: TaskGroup) => setToggled(current => {
    const next = new Set(current)
    if (!next.delete(id)) next.add(id)
    return next
  })
  return (
    <FlatList<TaskListRow<Task>>
      data={rows}
      keyExtractor={row => row.kind === 'section' ? `section:${row.id}` : row.task.id}
      initialNumToRender={40}
      {...underBar}
      refreshControl={<RefreshControl {...refresh} />}
      contentContainerStyle={{ paddingBottom: insets.bottom + bottom }}
      ListHeaderComponent={<ReadNotice error={error} hasData={Boolean(data)} label="任务" onRetry={reload} />}
      ListEmptyComponent={loading && !data ? <View style={styles.center}><Spinner /></View> : error ? undefined : <Text style={styles.empty}>没有任务</Text>}
      renderItem={({ item }) => item.kind === 'section'
        ? <TaskGroupBar id={item.id} count={item.count} folded={item.folded} onToggle={() => toggle(item.id)} />
        : <TaskRowView task={item.task} />}
    />
  )
}

/** A group's bar: grey and rounded, its icon, name and count; a tap folds or opens it. */
export function TaskGroupBar({ id, count, folded, onToggle }: { id: TaskGroup; count: number; folded: boolean; onToggle: () => void }) {
  const Chevron = folded ? ChevronRight : ChevronDown
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: !folded }} accessibilityLabel={`${GROUP_LABEL[id]}，${count}`}
      onPress={() => { tap(); onToggle() }} style={({ pressed }) => [styles.bar, pressed && { opacity: 0.7 }]}>
      <TaskGroupIcon group={id} size={16} />
      <Text style={styles.barTitle}>{GROUP_LABEL[id]}</Text>
      <Text style={styles.barCount}>{count}</Text>
      <View style={styles.fill} />
      <Chevron size={16} color={colors.tertiary} strokeWidth={2.2} />
    </Pressable>
  )
}

/**
 * A task: priority, state, the dispatching bot's avatar, number, title and date; a scheduled task adds its rule (「每天 09:00」, the server's words)
 * as a second line. It opens the task's detail, where its threads are (never a thread directly).
 */
export function TaskRowView({ task }: { task: Task }) {
  const router = useRouter()
  const group = groupOf(task)
  const when = task.createdAt ?? task.updatedAt
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={`${task.identifier ?? ''} ${task.title}，${GROUP_LABEL[group]}`}
      onPress={() => router.push(`/task/${task.id}`)}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }]}>
      <View style={styles.line}>
        <PriorityIcon priority={task.priority} />
        <TaskGroupIcon group={group} />
        {/* The avatar keeps its place without a bot, so numbers line up. */}
        {task.bot ? <BotAvatar color={task.bot.color} shape={task.bot.shape} size={18} /> : <View style={styles.noBot} />}
        {task.identifier ? <Text style={styles.key}>{task.identifier}</Text> : null}
        <Text style={styles.title} numberOfLines={1}>{displayTitle(task.title)}</Text>
        {when ? <Text style={styles.date}>{shortWhen(when)}</Text> : null}
      </View>
      {task.schedule ? (
        <View style={styles.schedule}>
          <CalendarClock size={13} color={colors.secondary} strokeWidth={2} />
          <Text style={styles.scheduleText} numberOfLines={1}>{task.schedule.label}</Text>
        </View>
      ) : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  center: { paddingTop: 40, alignItems: 'center' },
  empty: { textAlign: 'center', color: colors.secondary, marginTop: 40, fontSize: 15 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 36, marginHorizontal: ROW_SURFACE_INSET, marginTop: 12, marginBottom: 2, paddingHorizontal: LIST_INSET - ROW_SURFACE_INSET, borderRadius: 10, borderCurve: 'continuous', backgroundColor: colors.bubble },
  barTitle: { fontSize: 15, lineHeight: 20, fontWeight: '600', color: colors.text },
  barCount: { fontSize: 15, lineHeight: 20, color: colors.secondary, fontVariant: ['tabular-nums'] },
  fill: { flex: 1 },
  row: { justifyContent: 'center', gap: 2, minHeight: 48, paddingVertical: 8, marginHorizontal: ROW_SURFACE_INSET, paddingHorizontal: LIST_INSET - ROW_SURFACE_INSET, borderRadius: 10, borderCurve: 'continuous' },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  noBot: { width: 18, height: 18 },
  key: { fontSize: 14, color: colors.secondary, fontVariant: ['tabular-nums'] },
  title: { flex: 1, minWidth: 0, fontSize: 16, lineHeight: 21 },
  date: { fontSize: 14, color: colors.secondary, fontVariant: ['tabular-nums'] },
  /** Under the title, past the two icons and the avatar. */
  schedule: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingLeft: 16 + 18 + 18 + 24 },
  scheduleText: { flexShrink: 1, fontSize: 13, color: colors.secondary },
})
