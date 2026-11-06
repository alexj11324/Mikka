import { useState, type ReactElement } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Circle, CircleCheck, CircleDashed, CircleX } from 'lucide-react-native'
import { Spinner } from '@/components/icons'
import { ReadNotice } from '@/components/ReadNotice'
import { Text } from '@/components/Text'
import { underBar } from '@/components/NavBar'
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
  if (status === 'review') return <CircleDashed size={20} color={colors.success} strokeWidth={2} />
  if (status === 'canceled' || status === 'duplicate') return <CircleX size={20} color={colors.tertiary} strokeWidth={2} />
  return <Circle size={20} color={colors.secondary} strokeWidth={1.8} />
}

type Row = Task | { title: string } | { more: number; section: string }

/**
 * 任务 inside the 线程 tab (Comma design 15): the person's tasks by status, each a status mark, its title and
 * `#id · owner`. A task opens on the web, signed in; issue editing stays there (mobile.md). 已完成 and 已取消 show
 * their first rows until 显示全部.
 */
export function TaskList({ header }: { header?: ReactElement }) {
  const insets = useSafeAreaInsets()
  const home = useHome().data
  const { data, error, loading, reload } = useLiveApi<{ tasks: Task[] }>('/api/mobile/tasks', () => tasksLive(home?.live?.workspaceId, home?.workspace.id))
  const refresh = useRefresh(reload)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const rows: Row[] = SECTIONS.flatMap((section): Row[] => {
    const items = (data?.tasks ?? []).filter(task => section.status.includes(task.status))
    if (!items.length) return []
    const cut = section.closed && !open.has(section.title) && items.length > CLOSED_SHOWN
    return [{ title: section.title }, ...(cut ? items.slice(0, CLOSED_SHOWN) : items), ...(cut ? [{ more: items.length, section: section.title }] : [])]
  })
  return (
    <FlatList
      data={rows}
      keyExtractor={row => 'title' in row && !('id' in row) ? `h:${row.title}` : 'more' in row ? `more:${row.section}` : (row as Task).id}
      initialNumToRender={40}
      {...underBar}
      refreshControl={<RefreshControl {...refresh} />}
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      ListHeaderComponent={<View>{header}<ReadNotice error={error} hasData={Boolean(data)} label="任务" onRetry={reload} /></View>}
      ListEmptyComponent={loading ? <View style={styles.center}><Spinner /></View> : error ? undefined : <Text style={styles.empty}>没有任务</Text>}
      renderItem={({ item }) => 'more' in item ? <ShowAllRow count={item.more} onPress={() => setOpen(current => new Set(current).add(item.section))} />
        : !('id' in item) ? <ListSectionHeader title={item.title} />
        : (
          <Pressable accessibilityRole="link" onPress={() => void openOnWeb(`/?issue=${item.id}`)} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }]}>
            <View style={styles.icon}><TaskIcon status={item.status} /></View>
            <View style={styles.body}>
              <Text style={styles.title} numberOfLines={2}>{item.title}</Text>
              {item.identifier || item.owner ? <Text style={styles.meta} numberOfLines={1}>{[item.identifier ? `#${item.identifier.replace(/^\D+-/, '')}` : null, item.owner].filter(Boolean).join(' · ')}</Text> : null}
            </View>
          </Pressable>
        )}
    />
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 10, paddingHorizontal: 10, paddingVertical: 9, borderRadius: 10 },
  icon: { width: 22, alignItems: 'center' },
  mark: { width: 18, height: 18, borderRadius: 9 },
  half: { borderWidth: 2, borderColor: colors.orange, overflow: 'hidden', flexDirection: 'row' },
  halfFill: { width: '50%', backgroundColor: colors.orange },
  body: { flex: 1, minWidth: 0, gap: 2 },
  title: { fontSize: 17, lineHeight: 22 },
  meta: { fontSize: 13, lineHeight: 18, color: colors.secondary },
  center: { paddingTop: 40, alignItems: 'center' },
  empty: { textAlign: 'center', color: colors.secondary, marginTop: 40, fontSize: 15 },
})
