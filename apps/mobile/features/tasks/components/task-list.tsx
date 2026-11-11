import { mobileMessages } from '@/lib/messages'
import { useState } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronDown, ChevronRight } from 'lucide-react-native'
import { Spinner } from '@/components/icons'
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
import { colors, LIST_INSET, ROW_SURFACE_INSET, SPACE } from '@/lib/theme'
import { rowState, taskListRows, type TaskFilter, type TaskListRow } from '../model/task-groups'
import { readPresentedTasks } from '../model/task-presentation-read'
import { BOARD_LABEL, GROUP_LABEL, STATE_LABEL, TaskGroupIcon, TaskStateIcon } from './task-icons'

/** The person's tasks (GET /api/mobile/tasks), read again when a task or one of its threads changes (the live channel). */
export function useTasks(enabled = true) {
  const home = useHome().data
  return useLiveApi<{ tasks: Task[]; workspaceId: string }>(enabled ? '/api/mobile/tasks' : null,
    list => tasksLive(home?.live?.workspaceId, list?.workspaceId ?? home?.workspace.id, list?.tasks.map(task => task.id)), readPresentedTasks)
}

/**
 * The 任务 tab's list (decisions/2026-11-07-2045-tasks-only-threads-inside.md, Figma 1085:2 M1): 等待你 · 进行中 ·
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
      ListHeaderComponent={<ReadNotice error={error} hasData={Boolean(data)} label={mobileMessages.Nav.tasks} onRetry={reload} />}
      ListEmptyComponent={loading && !data ? <View style={styles.center}><Spinner /></View> : error ? undefined : <Text style={styles.empty}>{mobileMessages.MobileCore.noTasks}</Text>}
      renderItem={({ item }) => item.kind === 'section'
        ? <TaskGroupBar id={item.id} count={item.count} folded={item.folded} onToggle={() => toggle(item.id)} />
        : <TaskRowView task={item.task} />}
    />
  )
}

/** A group's header (Comma 15): its icon, name and count in the secondary colour on the page, no fill (Alex 2026-11-08:
 * no grey slabs), lined up with the rows' icons; a tap folds or opens it. */
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
 * A task (Figma 1085:2 M1): its own state's icon (never its group's, 2026-11-07-2230), number, title and date. A grey
 * line under it gives the reason (等你回复, 待审阅, 等 MIK-12), the dispatching bot and a scheduled task's rule
 * (「每天 09:00」). Priority stays in the detail. It opens the task's detail, where its threads are.
 */
export function TaskRowView({ task }: { task: Task }) {
  const router = useRouter()
  const { state, reason } = rowState(task)
  const when = task.createdAt ?? task.updatedAt
  const grey = [reason, task.bot?.name, task.schedule?.label].filter(Boolean).join(' · ')
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={[task.identifier, task.title, state ? STATE_LABEL[state] : BOARD_LABEL[task.status], grey].filter(Boolean).join('，')}
      onPress={() => router.push(`/task/${task.id}`)}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }]}>
      <View style={styles.line}>
        <TaskStateIcon state={state} status={task.status} />
        {task.identifier ? <Text style={styles.key}>{task.identifier}</Text> : null}
        <Text style={styles.title} numberOfLines={1}>{displayTitle(task.title)}</Text>
        {when ? <Text style={styles.date}>{shortWhen(when)}</Text> : null}
      </View>
      {grey ? <Text style={styles.grey} numberOfLines={1}>{grey}</Text> : null}
    </Pressable>
  )
}

/** A group bar adds only what the rows' own 15 pt padding leaves: 30 pt from the last row's text to the next bar, and
 * the first row's padding alone (about 12–15 pt) under the bar. */
const styles = StyleSheet.create({
  center: { paddingTop: 40, alignItems: 'center' },
  empty: { textAlign: 'center', color: colors.secondary, marginTop: 40, fontSize: 15 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 40, marginHorizontal: ROW_SURFACE_INSET, marginTop: SPACE.section - SPACE.rowY, marginBottom: 0, paddingHorizontal: LIST_INSET - ROW_SURFACE_INSET, borderRadius: 10, borderCurve: 'continuous' },
  barTitle: { fontSize: 15, lineHeight: 20, fontWeight: '600', color: colors.secondary },
  barCount: { fontSize: 15, lineHeight: 20, color: colors.secondary, fontVariant: ['tabular-nums'] },
  fill: { flex: 1 },
  row: { justifyContent: 'center', gap: SPACE.lineGap, minHeight: SPACE.rowMin, paddingVertical: SPACE.rowY, marginHorizontal: ROW_SURFACE_INSET, paddingHorizontal: LIST_INSET - ROW_SURFACE_INSET, borderRadius: 10, borderCurve: 'continuous' },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  key: { fontSize: 14, color: colors.secondary, fontVariant: ['tabular-nums'] },
  title: { flex: 1, minWidth: 0, fontSize: 16, lineHeight: 21 },
  date: { fontSize: 14, color: colors.secondary, fontVariant: ['tabular-nums'] },
  /** Under the title, past the state icon. */
  grey: { paddingLeft: 18 + 8, fontSize: 13, color: colors.secondary },
})
