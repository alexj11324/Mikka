import { Pressable, RefreshControl, SectionList, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowUpRight, Circle, CircleCheck, CircleDashed, CircleDot, CircleX } from 'lucide-react-native'
import { useDrawer } from '@/components/Drawer'
import { MenuIcon, Spinner } from '@/components/icons'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { NavBar, underBar } from '@/components/NavBar'
import type { Task } from '@/lib/types'
import { useApi, useRefresh } from '@/lib/useApi'
import { openOnWeb } from '@/lib/web'
import { colors } from '@/lib/theme'

/** The web's task statuses (lib/issue-meta.ts) in board order, with their names. */
const SECTIONS: { status: string[]; title: string }[] = [
  { status: ['doing'], title: '进行中' },
  { status: ['review'], title: '评审中' },
  { status: ['todo'], title: '待办' },
  { status: ['backlog'], title: '待整理' },
  { status: ['done'], title: '已完成' },
  { status: ['canceled', 'duplicate'], title: '已取消' },
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
  const drawer = useDrawer()
  const insets = useSafeAreaInsets()
  const { data, error, loading, reload } = useApi<{ tasks: Task[] }>('/api/mobile/tasks', 30_000)
  const refresh = useRefresh(reload)
  const sections = SECTIONS.map(s => ({ title: s.title, data: (data?.tasks ?? []).filter(t => s.status.includes(t.status)) })).filter(s => s.data.length)
  return (
    <View style={styles.screen}>
      <NavBar left={{ icon: 'line.3.horizontal', label: '菜单', onPress: drawer.open, web: <MenuIcon /> }} title="任务" />
      <SectionList
        sections={sections}
        keyExtractor={t => t.id}
        stickySectionHeadersEnabled={false}
        {...underBar}
        refreshControl={<RefreshControl {...refresh} />}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        ListEmptyComponent={loading ? <View style={{ paddingTop: 40, alignItems: 'center' }}><Spinner /></View> : <Text style={styles.empty}>{error ? '任务加载失败。' : '还没有任务。'}</Text>}
        renderSectionHeader={({ section }) => <Text style={styles.section}>{section.title}</Text>}
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
  section: { fontSize: 13, color: colors.secondary, marginLeft: 20, marginTop: 16, marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, height: 48 },
  key: { fontSize: 13, color: colors.secondary, minWidth: 56 },
  title: { flex: 1, fontSize: 16 },
  empty: { textAlign: 'center', color: colors.secondary, marginTop: 40, fontSize: 15 },
})
