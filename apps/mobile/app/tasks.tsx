import { useState } from 'react'
import { ReadNotice } from '@/components/ReadNotice'
import { Pressable, RefreshControl, SectionList, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowUpRight, Circle, CircleCheck, CircleDashed, CircleDot, CircleX } from 'lucide-react-native'
import { Spinner } from '@/components/icons'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { NavBar, underBar } from '@/components/NavBar'
import { CLOSED_SHOWN, ListSectionHeader, ShowAllRow } from '@/shared/components/list-section'
import type { Task } from '@/lib/types'
import { useLiveApi, useRefresh } from '@/lib/useApi'
import { tasksLive } from '@/lib/live-keys'
import { useHome } from '@/lib/home'
import { openOnWeb } from '@/lib/web'
import { colors } from '@/lib/theme'

/** The web's task statuses (lib/issue-meta.ts) in board order, with their names. */
const SECTIONS: { status: string[]; title: string; closed?: boolean }[] = [
  { status: ['doing'], title: '进行中' },
  { status: ['review'], title: '评审中' },
  { status: ['todo'], title: '待办' },
  { status: ['backlog'], title: '待整理' },
  { status: ['done'], title: '已完成', closed: true },
  { status: ['canceled', 'duplicate'], title: '已取消', closed: true },
]

function TaskIcon({ status }: { status: string }) {
  if (status === 'done') return <CircleCheck size={18} color={colors.success} strokeWidth={2} />
  if (status === 'doing') return <CircleDot size={18} color={colors.orange} strokeWidth={2} />
  if (status === 'review') return <CircleDashed size={18} color={colors.success} strokeWidth={2} />
  if (status === 'canceled' || status === 'duplicate') return <CircleX size={18} color={colors.tertiary} strokeWidth={2} />
  return <Circle size={18} color={colors.secondary} strokeWidth={2} />
}

/** 任务: a list grouped by status; no board on mobile (mobile.md, out of scope). */
export default function TasksScreen() {
  const insets = useSafeAreaInsets()
  const home = useHome().data
  const { data, error, loading, reload } = useLiveApi<{ tasks: Task[] }>('/api/mobile/tasks', () => tasksLive(home?.live?.workspaceId, home?.workspace.id))
  const refresh = useRefresh(reload)
  // A closed section shows its first rows until 显示全部, as OpenBot's task list does.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const sections = SECTIONS.map(s => {
    const all = (data?.tasks ?? []).filter(t => s.status.includes(t.status))
    const cut = s.closed && !opened.has(s.title) && all.length > CLOSED_SHOWN
    return { title: s.title, count: all.length, cut, data: cut ? all.slice(0, CLOSED_SHOWN) : all }
  }).filter(s => s.count)
  return (
    <View style={styles.screen}>
      <NavBar title="任务" large />
      <SectionList
        sections={sections}
        keyExtractor={t => t.id}
        stickySectionHeadersEnabled={false}
        initialNumToRender={40}
        {...underBar}
        refreshControl={<RefreshControl {...refresh} />}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        ListHeaderComponent={<ReadNotice error={error} hasData={Boolean(data)} label="任务" onRetry={reload} />}
        ListEmptyComponent={loading ? <View style={{ paddingTop: 40, alignItems: 'center' }}><Spinner /></View> : error ? undefined : <Text style={styles.empty}>还没有任务。</Text>}
        renderSectionHeader={({ section }) => <ListSectionHeader title={section.title} count={section.count} />}
        renderSectionFooter={({ section }) => section.cut ? <ShowAllRow count={section.count} onPress={() => setOpened(current => new Set([...current, section.title]))} /> : null}
        renderItem={({ item }) => (
          // The task opens on the web, signed in: issue editing stays there (mobile.md, out of scope).
          <Pressable accessibilityRole="link" onPress={() => void openOnWeb(`/?issue=${item.id}`)} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }]}>
            <TaskIcon status={item.status} />
            {item.identifier ? <Text style={styles.key}>{item.identifier}</Text> : null}
            <Text style={styles.title} numberOfLines={1}>{item.title}</Text>
            <Symbol name="arrow.up.right" size={12} color={colors.tertiary} web={<ArrowUpRight size={15} color={colors.tertiary} strokeWidth={2} />} />
          </Pressable>
        )}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, minHeight: 48, paddingVertical: 10 },
  key: { fontSize: 13, color: colors.secondary, minWidth: 56 },
  title: { flex: 1, fontSize: 16 },
  empty: { textAlign: 'center', color: colors.secondary, marginTop: 40, fontSize: 15 },
})
