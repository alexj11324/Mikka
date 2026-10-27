import { SectionList, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Circle, CircleCheck, CircleDashed, CircleDot } from 'lucide-react-native'
import { useDrawer } from '@/components/Drawer'
import { MenuIcon } from '@/components/icons'
import { Text } from '@/components/Text'
import { Header, RoundButton } from '@/components/ui'
import { tasks, type Task } from '@/lib/mock'
import { colors } from '@/lib/theme'

const SECTIONS: { status: Task['status']; title: string }[] = [
  { status: 'doing', title: '进行中' },
  { status: 'review', title: '待审阅' },
  { status: 'todo', title: '待办' },
  { status: 'done', title: '已完成' },
]

function TaskIcon({ status }: { status: Task['status'] }) {
  if (status === 'done') return <CircleCheck size={18} color={colors.success} strokeWidth={2} />
  if (status === 'doing') return <CircleDot size={18} color={colors.orange} strokeWidth={2} />
  if (status === 'review') return <CircleDashed size={18} color={colors.prOpen} strokeWidth={2} />
  return <Circle size={18} color={colors.secondary} strokeWidth={2} />
}

/** 任务: a list grouped by status; no board on mobile (mobile.md, out of scope). */
export default function TasksScreen() {
  const drawer = useDrawer()
  const insets = useSafeAreaInsets()
  const sections = SECTIONS.map(s => ({ title: s.title, data: tasks.filter(t => t.status === s.status) })).filter(s => s.data.length)
  return (
    <View style={styles.screen}>
      <Header left={<RoundButton label="菜单" onPress={drawer.open}><MenuIcon /></RoundButton>} title="任务" />
      <SectionList
        sections={sections}
        keyExtractor={t => t.id}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        renderSectionHeader={({ section }) => <Text style={styles.section}>{section.title}</Text>}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <TaskIcon status={item.status} />
            <Text style={styles.key}>{item.key}</Text>
            <Text style={styles.title} numberOfLines={1}>{item.title}</Text>
            <Text style={styles.assignee} numberOfLines={1}>{item.assignee}</Text>
          </View>
        )}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  section: { fontSize: 13, color: colors.secondary, marginLeft: 20, marginTop: 16, marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, height: 48 },
  key: { fontSize: 13, color: colors.secondary, width: 56 },
  title: { flex: 1, fontSize: 16 },
  assignee: { fontSize: 13, color: colors.secondary, maxWidth: 110 },
})
