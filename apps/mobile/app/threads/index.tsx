import { type ComponentType, useMemo, useState } from 'react'
import { FlatList, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Check, CircleCheck, Hand, List, LoaderCircle, Plus, SlidersHorizontal } from 'lucide-react-native'
import { useDrawer } from '@/components/Drawer'
import { MachineIcon, MenuIcon, Spinner, StatusIcon } from '@/components/icons'
import { Text } from '@/components/Text'
import { NavBar, underBar } from '@/components/NavBar'
import { Dot } from '@/components/ui'
import type { Thread, Threads } from '@/lib/types'
import { switchTo } from '@/lib/navigate'
import { useApi, useRefresh } from '@/lib/useApi'
import { colors, lift } from '@/lib/theme'

// 待审阅 and 已归档 (Figma 03b) wait for the server to track reviews and archiving.
type Filter = 'all' | 'waiting' | 'running' | 'done'
const filters: { id: Filter; label: string; icon: ComponentType<{ size?: number; color?: string; strokeWidth?: number }>; symbol: 'list.bullet' | 'hand.raised' | 'arrow.triangle.2.circlepath' | 'checkmark.circle' }[] = [
  { id: 'all', label: '全部', icon: List, symbol: 'list.bullet' },
  { id: 'waiting', label: '等你回复', icon: Hand, symbol: 'hand.raised' },
  { id: 'running', label: '进行中', icon: LoaderCircle, symbol: 'arrow.triangle.2.circlepath' },
  { id: 'done', label: '已完成', icon: CircleCheck, symbol: 'checkmark.circle' },
]

const matches = (thread: Thread, filter: Filter) => {
  if (filter === 'all') return true
  if (filter === 'done') return thread.status === 'done' || thread.status === 'stopped'
  return thread.status === filter
}

/** Threads waiting on the person sort first (mobile.md). */
const rank = (thread: Thread) => (thread.status === 'waiting' ? 0 : thread.status === 'running' ? 1 : 2)

/** 线程, like the Claude app's Code screen: 设备 chips, filter menu, 新线程 pill (mobile.md). */
export default function ThreadsScreen() {
  const drawer = useDrawer()
  const router = useRouter()
  // From a chat's 线程 button: pushed over that chat (back returns to it), showing that bot's threads.
  const { bot } = useLocalSearchParams<{ bot?: string }>()
  const pushed = router.canGoBack()
  const insets = useSafeAreaInsets()
  const { data, loading, error, reload } = useApi<Threads>('/api/mobile/threads', 10_000)
  const refresh = useRefresh(reload)
  const [machine, setMachine] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [menu, setMenu] = useState(false)

  const list = useMemo(() => (data?.threads ?? [])
    .filter(t => matches(t, filter) && (!machine || t.device?.id === machine) && (!bot || t.by === bot))
    .sort((a, b) => rank(a) - rank(b)), [data, filter, machine, bot])

  return (
    <View style={styles.screen}>
      <NavBar
        left={pushed ? undefined : { icon: 'line.3.horizontal', label: '菜单', onPress: drawer.open, web: <MenuIcon /> }}
        back={pushed ? () => router.back() : undefined}
        title={bot ? `${bot} 的线程` : '线程'}
        right={{ icon: 'line.3.horizontal.decrease', label: '筛选', web: <SlidersHorizontal size={20} color={colors.ink} strokeWidth={2} />, onOpen: () => setMenu(true),
          items: filters.map(f => ({ label: f.label, icon: f.symbol, on: filter === f.id, onPress: () => setFilter(f.id) })) }}
      />
      <FlatList
        data={list}
        keyExtractor={t => t.id}
        {...underBar}
        refreshControl={<RefreshControl {...refresh} />}
        contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
        ListHeaderComponent={
          <View>
            {data?.devices.length ? <Text style={styles.section}>设备</Text> : null}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {(data?.devices ?? []).map(m => {
                const active = machine === m.id
                return (
                  <Pressable key={m.id} accessibilityRole="button" onPress={() => setMachine(active ? null : m.id)} style={[styles.chip, active && styles.chipActive]}>
                    <MachineIcon machine={m.kind} size={16} color={active ? '#fff' : colors.ink} />
                    <Text style={[styles.chipText, active && { color: '#fff' }]}>{m.name}</Text>
                    {m.online ? <View style={styles.online} /> : null}
                  </Pressable>
                )
              })}
            </ScrollView>
            <Text style={styles.section}>{filter === 'all' ? '线程' : filters.find(f => f.id === filter)?.label}</Text>
          </View>
        }
        ListEmptyComponent={loading ? <View style={{ paddingTop: 40, alignItems: 'center' }}><Spinner /></View> : <Text style={styles.empty}>{error ? '线程加载失败。' : '没有线程'}</Text>}
        renderItem={({ item }) => <ThreadRow thread={item} onPress={() => router.push(`/threads/${item.id}`)} />}
      />
      <View style={[styles.bottom, { paddingBottom: Math.max(insets.bottom, 12) }]} pointerEvents="box-none">
        <View />
        <Pressable accessibilityRole="button" onPress={() => switchTo({ pathname: '/', params: { compose: '1' } })} style={styles.newThread}>
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

/** Status icon, name, one grey line: bot and machine icon. Only 等你回复 adds a word (mobile.md). */
function ThreadRow({ thread, onPress }: { thread: Thread; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }]}>
      <View style={styles.rowIcon}><StatusIcon status={thread.status} size={20} /></View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle} numberOfLines={1}>{thread.name}</Text>
        <View style={styles.rowMeta}>
          <Text style={styles.rowMetaText}>{thread.status === 'waiting' ? '等你回复 · ' : ''}{thread.by}</Text>
          {thread.device ? <MachineIcon machine={thread.device.kind} size={13} /> : null}
        </View>
      </View>
      {thread.status === 'waiting' ? <Dot /> : null}
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
