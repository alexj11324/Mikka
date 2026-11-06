import { useState, type ReactElement } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Circle, CircleDashed, CircleX } from 'lucide-react-native'
import { Spinner } from '@/components/icons'
import { ReadNotice } from '@/components/ReadNotice'
import { Text } from '@/components/Text'
import { underBar } from '@/components/NavBar'
import { displayTitle } from '@/lib/display-title'
import type { Task } from '@/lib/types'
import { useLiveApi, useRefresh } from '@/lib/useApi'
import { tasksLive } from '@/lib/live-keys'
import { useHome } from '@/lib/home'
import { openOnWeb } from '@/lib/web'
import { colors } from '@/lib/theme'
import { CLOSED_SHOWN, ListSectionHeader, ShowAllRow } from '@/shared/components/list-section'

/** The web's task statuses (lib/issue-meta.ts) in board order, with their names; the closed ones last. */
const SECTIONS: { status: string[]; title: string; closed?: boolean }[] = [
  { status: ['doing'], title: '进行中' },
  { status: ['review'], title: '评审中' },
  { status: ['todo'], title: '待办' },
  { status: ['backlog'], title: '待整理' },
  { status: ['done'], title: '已完成', closed: true },
  { status: ['canceled', 'duplicate'], title: '已取消', closed: true },
]

/** A task's status mark (Comma design 15): an orange half circle in progress, a filled green circle done. */
function TaskIcon({ status }: { status: string }) {
  if (status === 'done') return <View style={[styles.mark, { backgroundColor: colors.success }]} accessibilityLabel="已完成" />
  if (status === 'doing') return <View style={[styles.mark, styles.half]} accessibilityLabel="进行中"><View style={styles.halfFill} /></View>
  if (status === 'review') return <CircleDashed size={20} color={colors.success} strokeWidth={2} accessibilityLabel="评审中" />
  if (status === 'canceled' || status === 'duplicate') return <CircleX size={20} color={colors.tertiary} strokeWidth={2} accessibilityLabel="已取消" />
  return <Circle size={20} color={colors.secondary} strokeWidth={1.8} accessibilityLabel="待办" />
}

export type TaskRow = { key: string; task: Task } | { key: string; title: string } | { key: string; more: number; section: string }

/**
 * The person's tasks as list rows by status (Comma design 15): a section name, then each task as its status mark and
 * its title on one line (Alex 2026-11-06). 已完成 and 已取消 show their first rows until 显示全部. The 线程 tab draws
 * these rows in its own list, so its large title and segment stay on one scroll view.
 */
export function useTaskRows(enabled = true) {
  const home = useHome().data
  const { data, error, loading, reload } = useLiveApi<{ tasks: Task[] }>(enabled ? '/api/mobile/tasks' : null, () => tasksLive(home?.live?.workspaceId, home?.workspace.id))
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const rows: TaskRow[] = SECTIONS.flatMap((section): TaskRow[] => {
    const items = (data?.tasks ?? []).filter(task => section.status.includes(task.status))
    if (!items.length) return []
    const cut = section.closed && !open.has(section.title) && items.length > CLOSED_SHOWN
    return [
      { key: `h:${section.title}`, title: section.title },
      ...(cut ? items.slice(0, CLOSED_SHOWN) : items).map(task => ({ key: task.id, task })),
      ...(cut ? [{ key: `more:${section.title}`, more: items.length, section: section.title }] : []),
    ]
  })
  const render = (row: TaskRow) => 'task' in row ? <TaskRowView task={row.task} />
    : 'more' in row ? <ShowAllRow count={row.more} onPress={() => setOpen(current => new Set(current).add(row.section))} />
    : <ListSectionHeader title={row.title} />
  return { rows, render, data, error, loading, reload }
}

/** A task: its status mark and its title on one line; it opens on the web, signed in (issue editing stays there). */
function TaskRowView({ task }: { task: Task }) {
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={task.title} onPress={() => void openOnWeb(`/?issue=${task.id}`)}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }]}>
      <View style={styles.icon}><TaskIcon status={task.status} /></View>
      <Text style={styles.title} numberOfLines={1}>{displayTitle(task.title)}</Text>
    </Pressable>
  )
}

/** 任务 on its own page (opened from a chat's task card): the same rows in their own list. */
export function TaskList({ header }: { header?: ReactElement }) {
  const insets = useSafeAreaInsets()
  const { rows, render, data, error, loading, reload } = useTaskRows()
  const refresh = useRefresh(reload)
  return (
    <FlatList
      data={rows}
      keyExtractor={row => row.key}
      initialNumToRender={40}
      {...underBar}
      refreshControl={<RefreshControl {...refresh} />}
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      ListHeaderComponent={<View>{header}<ReadNotice error={error} hasData={Boolean(data)} label="任务" onRetry={reload} /></View>}
      ListEmptyComponent={loading ? <View style={styles.center}><Spinner /></View> : error ? undefined : <Text style={styles.empty}>没有任务</Text>}
      renderItem={({ item }) => render(item)}
    />
  )
}

export const listStyles = StyleSheet.create({
  center: { paddingTop: 40, alignItems: 'center' },
  empty: { textAlign: 'center', color: colors.secondary, marginTop: 40, fontSize: 15 },
})

const styles = StyleSheet.create({
  /** One line per row (Alex 2026-11-06): 52 pt tall, the pressed surface 10 pt in from each side. */
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, marginHorizontal: 10, paddingHorizontal: 10, borderRadius: 10 },
  icon: { width: 22, alignItems: 'center' },
  mark: { width: 18, height: 18, borderRadius: 9 },
  half: { borderWidth: 2, borderColor: colors.orange, overflow: 'hidden', flexDirection: 'row' },
  halfFill: { width: '50%', backgroundColor: colors.orange },
  title: { flex: 1, minWidth: 0, fontSize: 17, lineHeight: 22 },
  center: listStyles.center,
  empty: listStyles.empty,
})
