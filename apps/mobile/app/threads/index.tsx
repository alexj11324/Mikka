import { type ComponentType, useMemo, useState } from 'react'
import { FlatList, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Archive, Check, CircleCheck, Eye, Hand, List, LoaderCircle, Plus, Search, SlidersHorizontal } from 'lucide-react-native'
import { useDrawer } from '@/components/Drawer'
import { MachineIcon, MenuIcon, StatusIcon } from '@/components/icons'
import { Text } from '@/components/Text'
import { Dot, Header, RoundButton } from '@/components/ui'
import { machines, threads, type Machine, type Thread } from '@/lib/mock'
import { colors, lift } from '@/lib/theme'

type Filter = 'all' | 'waiting' | 'review' | 'running' | 'done' | 'archived'
const filters: { id: Filter; label: string; icon: ComponentType<{ size?: number; color?: string; strokeWidth?: number }> }[] = [
  { id: 'all', label: '全部', icon: List },
  { id: 'waiting', label: '等你回复', icon: Hand },
  { id: 'review', label: '待审阅', icon: Eye },
  { id: 'running', label: '进行中', icon: LoaderCircle },
  { id: 'done', label: '已完成', icon: CircleCheck },
  { id: 'archived', label: '已归档', icon: Archive },
]

const matches = (thread: Thread, filter: Filter) => {
  if (filter === 'archived') return !!thread.archived
  if (thread.archived) return false
  if (filter === 'all') return true
  if (filter === 'done') return ['done', 'merged', 'closed'].includes(thread.status)
  return thread.status === filter
}

/** Threads waiting on the person sort first (mobile.md). */
const rank = (thread: Thread) => (thread.status === 'waiting' || thread.status === 'review' ? 0 : thread.status === 'running' ? 1 : 2)

/** 线程, like the Claude app's Code screen: 设备 chips, filter menu, 新线程 pill (mobile.md). */
export default function ThreadsScreen() {
  const drawer = useDrawer()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [machine, setMachine] = useState<Machine | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [menu, setMenu] = useState(false)

  const list = useMemo(() => threads
    .filter(t => matches(t, filter) && (!machine || t.machine === machine))
    .sort((a, b) => rank(a) - rank(b)), [filter, machine])

  return (
    <View style={styles.screen}>
      <Header
        left={<RoundButton label="菜单" onPress={drawer.open}><MenuIcon /></RoundButton>}
        title="线程"
        right={<RoundButton label="筛选" onPress={() => setMenu(true)}><SlidersHorizontal size={20} color={colors.ink} strokeWidth={2} /></RoundButton>}
      />
      <FlatList
        data={list}
        keyExtractor={t => t.id}
        contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
        ListHeaderComponent={
          <View>
            <Text style={styles.section}>设备</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {machines.map(m => {
                const active = machine === m.id
                return (
                  <Pressable key={m.id} accessibilityRole="button" onPress={() => setMachine(active ? null : m.id)} style={[styles.chip, active && styles.chipActive]}>
                    <MachineIcon machine={m.id} size={16} color={active ? '#fff' : colors.ink} />
                    <Text style={[styles.chipText, active && { color: '#fff' }]}>{m.name}</Text>
                    {m.id !== 'server' ? <View style={styles.online} /> : null}
                  </Pressable>
                )
              })}
            </ScrollView>
            <Text style={styles.section}>{filter === 'all' ? '线程' : filters.find(f => f.id === filter)?.label}</Text>
          </View>
        }
        ListEmptyComponent={<Text style={styles.empty}>没有线程</Text>}
        renderItem={({ item }) => <ThreadRow thread={item} onPress={() => router.push(`/threads/${item.id}`)} />}
      />
      <View style={[styles.bottom, { paddingBottom: Math.max(insets.bottom, 12) }]} pointerEvents="box-none">
        <RoundButton label="搜索"><Search size={20} color={colors.ink} strokeWidth={2} /></RoundButton>
        <Pressable accessibilityRole="button" onPress={() => router.replace('/')} style={styles.newThread}>
          <Plus size={18} color="#fff" strokeWidth={2.4} />
          <Text style={styles.newThreadText}>新线程</Text>
        </Pressable>
      </View>
      <Modal visible={menu} transparent animationType="fade" onRequestClose={() => setMenu(false)}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setMenu(false)}>
          <View style={[styles.menu, { top: insets.top + 64 }]}>
            {filters.map(f => (
              <Pressable key={f.id} accessibilityRole="menuitem" onPress={() => { setFilter(f.id); setMenu(false) }} style={({ pressed }) => [styles.menuRow, pressed && { backgroundColor: colors.pressed }]}>
                <View style={{ width: 18 }}>{filter === f.id ? <Check size={16} color={colors.ink} strokeWidth={2.4} /> : null}</View>
                <f.icon size={18} color={colors.ink} strokeWidth={1.8} />
                <Text style={{ fontSize: 16 }}>{f.label}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </View>
  )
}

/** Status icon, name, one grey line: bot and machine icon. Only 等你回复 and 待审阅 add a word (mobile.md). */
function ThreadRow({ thread, onPress }: { thread: Thread; onPress: () => void }) {
  const word = thread.status === 'waiting' ? '等你回复' : thread.status === 'review' ? '待审阅' : null
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }]}>
      <View style={styles.rowIcon}><StatusIcon status={thread.status} size={20} /></View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle} numberOfLines={1}>{thread.title}</Text>
        <View style={styles.rowMeta}>
          <Text style={styles.rowMetaText}>{word ? `${word} · ` : ''}{thread.bot}</Text>
          <MachineIcon machine={thread.machine} size={13} />
        </View>
      </View>
      {thread.unread ? <Dot /> : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  section: { fontSize: 13, color: colors.secondary, marginLeft: 20, marginTop: 12, marginBottom: 8 },
  chips: { paddingHorizontal: 16, gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 7, height: 40, paddingHorizontal: 14, borderRadius: 20, backgroundColor: colors.bubble },
  chipActive: { backgroundColor: colors.ink },
  chipText: { fontSize: 15 },
  online: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.success },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 11, gap: 12 },
  rowIcon: { width: 22, alignItems: 'center' },
  rowTitle: { fontSize: 16 },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 },
  rowMetaText: { fontSize: 12, color: colors.secondary },
  empty: { textAlign: 'center', color: colors.secondary, marginTop: 40 },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16 },
  newThread: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 48, paddingHorizontal: 20, borderRadius: 24, backgroundColor: colors.ink },
  newThreadText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  menu: { position: 'absolute', right: 16, width: 220, backgroundColor: '#fff', borderRadius: 18, paddingVertical: 6, ...lift, shadowOpacity: 0.16, shadowRadius: 24 },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, height: 44 },
})
