import { ReadNotice } from '@/components/ReadNotice'
import { type ComponentType, useEffect, useMemo, useState } from 'react'
import { FlatList, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Check, List, Plus, SlidersHorizontal } from 'lucide-react-native'
import { MachineIcon, Spinner, StatusIcon } from '@/components/icons'
import { GROUP_ICON } from '@/lib/thread-icon'
import { Text } from '@/components/Text'
import { NavBar, underBar } from '@/components/NavBar'
import { Dot } from '@/components/ui'
import type { BotPage, Thread, ThreadGroup, Threads } from '@/lib/types'
import { openChat } from '@/lib/navigate'
import { useApi, useRefresh } from '@/lib/useApi'
import { colors, lift } from '@/lib/theme'
import { HARNESS } from '@/lib/harness'

// 待审阅 and 已归档 (Figma 03b) wait for the server to track reviews and archiving.
type Filter = 'all' | 'waiting' | 'running' | 'resolved'
/** A thread group's menu icon: the same bubble and dot its rows show (R-52), never a task's circle. */
const groupIcon = (group: ThreadGroup) => function GroupIcon({ size = 18 }: { size?: number }) { return <StatusIcon status={GROUP_ICON[group]} size={size} /> }
const filters: { id: Filter; label: string; icon: ComponentType<{ size?: number; color?: string; strokeWidth?: number }>; symbol: 'list.bullet' | 'bubble.left' }[] = [
  { id: 'all', label: '全部', icon: List, symbol: 'list.bullet' },
  { id: 'waiting', label: '等待你', icon: groupIcon('waiting'), symbol: 'bubble.left' },
  { id: 'running', label: '进行中', icon: groupIcon('running'), symbol: 'bubble.left' },
  { id: 'resolved', label: '已解决', icon: groupIcon('resolved'), symbol: 'bubble.left' },
]

/** The server's group (R-52); an older server sends none, so its status stands in, never as resolved. */
export const groupOf = (thread: Thread): ThreadGroup => thread.group ?? (thread.status === 'running' ? 'running' : thread.status === 'failed' || thread.status === 'paused' ? 'blocked' : 'waiting')

const matches = (thread: Thread, filter: Filter) => filter === 'all' || groupOf(thread) === filter

/** The web's order and names (R-52); 已解决 last. */
const GROUPS: { id: ThreadGroup; title: string }[] = [
  { id: 'waiting', title: '等待你' },
  { id: 'running', title: '进行中' },
  { id: 'blocked', title: '受阻' },
  { id: 'idle', title: '空闲' },
  { id: 'resolved', title: '已解决' },
]

const rank = (thread: Thread) => GROUPS.findIndex(group => group.id === groupOf(thread))

/** The row's icon says its group, not the run's raw status: a run that finished blocked shows the alert, never the check. */

/** 线程, like the Claude app's Code screen: 设备 chips, filter menu, 新线程 pill (mobile.md). */
export function ThreadsScreen({ bot }: { bot?: { id: string; name: string } }) {
  const router = useRouter()
  // `bot`: one bot's threads, pushed over its chat; otherwise the 线程 tab.
  const pushed = bot !== undefined
  const insets = useSafeAreaInsets()
  const { data, loading, error, reload } = useApi<Threads | BotPage>(bot ? `/api/mobile/bots/${bot.id}` : '/api/mobile/threads', 10_000)
  const devices = data && 'devices' in data ? data.devices : []
  const refresh = useRefresh(reload)
  const [machine, setMachine] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [menu, setMenu] = useState(false)

  // A workspace change or removed device must not leave an invisible filter.
  useEffect(() => {
    if (!data || !machine) return
    const available = 'devices' in data ? data.devices : []
    if (!available.some(device => device.id === machine)) setMachine(null)
  }, [data, machine])

  const list = useMemo(() => (data?.threads ?? [])
    .filter(t => matches(t, filter) && (!machine || t.device?.id === machine))
    .sort((a, b) => rank(a) - rank(b)), [data, filter, machine])
  // 全部: grouped as on the web (R-52).
  const rows: (Thread | { title: string })[] = filter !== 'all' ? list : GROUPS.flatMap(group => {
    const items = list.filter(thread => groupOf(thread) === group.id)
    return items.length ? [{ title: group.title }, ...items] : []
  })

  return (
    <View style={styles.screen}>
      <NavBar
        back={pushed ? () => router.back() : undefined}
        title={bot ? `${bot.name} 的线程` : '线程'}
        large={!pushed}
        right={[{ icon: 'square.and.pencil', label: '新线程', web: <Plus size={20} color={colors.ink} strokeWidth={2} />, onPress: () => openChat({ pathname: '/bots/[id]', params: { id: 'coordinator', compose: '1' } }) }, { icon: 'line.3.horizontal.decrease', label: '筛选', web: <SlidersHorizontal size={20} color={colors.ink} strokeWidth={2} />, onOpen: () => setMenu(true),
          items: filters.map(f => ({ label: f.label, icon: f.symbol, on: filter === f.id, onPress: () => setFilter(f.id) })) }]}
      />
      <FlatList
        data={rows}
        keyExtractor={row => 'title' in row ? `h:${row.title}` : row.id}
        {...underBar}
        refreshControl={<RefreshControl {...refresh} />}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        ListHeaderComponent={
          <View>
            <ReadNotice error={error} hasData={Boolean(data)} label="线程" onRetry={reload} />
            {devices.length ? <Text style={styles.section}>设备</Text> : null}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {devices.map(m => {
                const active = machine === m.id
                return (
                  <Pressable key={m.id} accessibilityRole="button" accessibilityState={{ selected: active }} onPress={() => setMachine(active ? null : m.id)} style={({ pressed }) => [styles.chip, active && styles.chipActive, pressed && { opacity: 0.7 }]}>
                    <MachineIcon machine={m.kind} size={16} color={active ? colors.onInk : colors.ink} />
                    <Text style={[styles.chipText, active && { color: colors.onInk }]}>{m.name}</Text>
                    {m.online ? <View style={styles.online} /> : null}
                  </Pressable>
                )
              })}
            </ScrollView>
            {filter === 'all' ? null : <Text style={styles.section}>{filters.find(f => f.id === filter)?.label}</Text>}
          </View>
        }
        ListEmptyComponent={loading ? <View style={{ paddingTop: 40, alignItems: 'center' }}><Spinner /></View> : error ? undefined : <Text style={styles.empty}>没有线程</Text>}
        renderItem={({ item }) => 'title' in item ? <Text style={styles.section}>{item.title}</Text> : <ThreadRow thread={item} onPress={() => router.push(`/thread/${item.id}`)} />}
      />
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

/** Status icon, name, one grey line: the Agent running it (R-78) and the machine icon. Only 等待你 adds a word (mobile.md), and a task's later attempt its number. */
export function ThreadRow({ thread, onPress }: { thread: Thread; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }]}>
      <View style={styles.rowIcon}><StatusIcon status={thread.group ? GROUP_ICON[thread.group] : thread.status} size={20} /></View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle} numberOfLines={1}>{thread.name}</Text>
        <View style={styles.rowMeta}>
          <Text style={styles.rowMetaText}>{thread.status === 'waiting' ? '等待你 · ' : ''}{(thread.attempts ?? 1) > 1 ? `第 ${thread.attempts} 次尝试 · ` : ''}{HARNESS[thread.harness] ?? thread.harness}</Text>
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
  chip: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 44, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20, backgroundColor: colors.bubble },
  chipActive: { backgroundColor: colors.ink },
  chipText: { fontSize: 15 },
  online: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.success },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 11, gap: 12 },
  rowIcon: { width: 22, alignItems: 'center' },
  rowTitle: { fontSize: 16 },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 },
  rowMetaText: { fontSize: 12, color: colors.secondary },
  empty: { textAlign: 'center', color: colors.secondary, marginTop: 40 },
  failed: { alignItems: 'center', gap: 10, marginTop: 40 },
  error: { fontSize: 13, color: colors.danger },
  menu: { position: 'absolute', right: 16, width: 220, backgroundColor: colors.surface, borderRadius: 18, paddingVertical: 6, ...lift, shadowOpacity: 0.16, shadowRadius: 24 },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, minHeight: 44, paddingVertical: 10 },
})
