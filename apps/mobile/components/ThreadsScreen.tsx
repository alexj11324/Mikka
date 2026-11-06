import { ReadNotice } from '@/components/ReadNotice'
import { useEffect, useMemo, useState } from 'react'
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Plus } from 'lucide-react-native'
import { MachineIcon, Spinner, StatusIcon } from '@/components/icons'
import { GROUP_ICON } from '@/lib/thread-icon'
import { Text } from '@/components/Text'
import { NavBar, underBar } from '@/components/NavBar'
import { Dot } from '@/components/ui'
import type { BotPage, Thread, ThreadGroup, Threads } from '@/lib/types'
import { openChat } from '@/lib/navigate'
import { useLiveApi, useRefresh } from '@/lib/useApi'
import { botPageLive, threadsLive } from '@/lib/live-keys'
import { useHome } from '@/lib/home'
import { colors } from '@/lib/theme'
import { HARNESS } from '@/lib/harness'
import { CLOSED_SHOWN, ListSectionHeader, ShowAllRow } from '@/shared/components/list-section'
import { ThreadLink } from '@/shared/components/thread-link'
import { Segmented } from '@/components/Segmented'
import { TaskList } from '@/features/tasks/components/task-list'
import { StatusSwitcher, type ThreadFilter as Filter } from '@/features/threads/components/status-switcher'

// 待审阅 and 已归档 (Figma 03b) wait for the server to track reviews and archiving.
const FILTER_TITLE: Record<Filter, string> = { all: '全部', waiting: '等待你', running: '进行中', resolved: '已解决' }

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

/**
 * 线程 (Comma designs 13 and 15): on the tab, a 线程 | 任务 segment under the large title; 线程 has the device chips,
 * the threads by group and the floating status switcher above the tab bar, which replaced the filter menu (Alex
 * 2026-11-06). A bot's threads, pushed over its chat, are the same list without the segment.
 */
export function ThreadsScreen({ bot }: { bot?: { id: string; name: string } }) {
  const router = useRouter()
  // `bot`: one bot's threads, pushed over its chat; otherwise the 线程 tab.
  const pushed = bot !== undefined
  const insets = useSafeAreaInsets()
  const home = useHome().data
  const own = home?.live?.workspaceId
  // The Coordinator's page is addressed as `coordinator`; its key is its bot row's id.
  const botId = bot?.id === 'coordinator' ? home?.bots.find(item => item.coordinator)?.id : bot?.id
  const { data, loading, error, reload } = useLiveApi<Threads | BotPage>(bot ? `/api/mobile/bots/${bot.id}` : '/api/mobile/threads',
    current => bot ? botPageLive(current as BotPage | null, botId, own, home?.workspace.id) : threadsLive(current as Threads | null, own))
  const devices = data && 'devices' in data ? data.devices : []
  const refresh = useRefresh(reload)
  const [machine, setMachine] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [segment, setSegment] = useState<'threads' | 'tasks'>('threads')

  // A workspace change or removed device must not leave an invisible filter.
  useEffect(() => {
    if (!data || !machine) return
    const available = 'devices' in data ? data.devices : []
    if (!available.some(device => device.id === machine)) setMachine(null)
  }, [data, machine])

  const list = useMemo(() => (data?.threads ?? [])
    .filter(t => matches(t, filter) && (!machine || t.device?.id === machine))
    .sort((a, b) => rank(a) - rank(b)), [data, filter, machine])
  // 全部: grouped as on the web (R-52), each with its count; 已解决 shows its first rows until 显示全部.
  const [allResolved, setAllResolved] = useState(false)
  type Row = Thread | { title: string } | { more: number }
  const rows: Row[] = filter !== 'all' ? list : GROUPS.flatMap((group): Row[] => {
    const items = list.filter(thread => groupOf(thread) === group.id)
    if (!items.length) return []
    const cut = group.id === 'resolved' && !allResolved && items.length > CLOSED_SHOWN
    return [{ title: group.title }, ...(cut ? items.slice(0, CLOSED_SHOWN) : items), ...(cut ? [{ more: items.length }] : [])]
  })

  // The tab's 线程 | 任务 switch; a bot's own threads have no tasks segment.
  const switcher = pushed ? undefined : (
    <View style={styles.segment}>
      <Segmented options={[{ value: 'threads', label: '线程' }, { value: 'tasks', label: '任务' }]} value={segment} onChange={setSegment} />
    </View>
  )

  return (
    <View style={styles.screen}>
      <NavBar
        back={pushed ? () => router.back() : undefined}
        title={bot ? `${bot.name} 的线程` : '线程'}
        large={!pushed}
        right={{ icon: 'square.and.pencil', label: '新线程', web: <Plus size={20} color={colors.ink} strokeWidth={2} />, onPress: () => openChat({ pathname: '/bots/[id]', params: { id: 'coordinator', compose: '1' } }) }}
      />
      {segment === 'tasks' ? <TaskList header={switcher} /> : <>
      <FlatList
        data={rows}
        keyExtractor={row => 'title' in row ? `h:${row.title}` : 'more' in row ? 'more' : row.id}
        // The sections, their first rows and 显示全部 draw at once rather than ten rows at a time.
        initialNumToRender={40}
        {...underBar}
        refreshControl={<RefreshControl {...refresh} />}
        contentContainerStyle={{ paddingBottom: insets.bottom + 88 }}
        ListHeaderComponent={
          <View>
            {switcher}
            <ReadNotice error={error} hasData={Boolean(data)} label="线程" onRetry={reload} />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {devices.map(m => {
                const active = machine === m.id
                return (
                  <Pressable key={m.id} accessibilityRole="button" accessibilityState={{ selected: active }} onPress={() => setMachine(active ? null : m.id)} style={({ pressed }) => [styles.chip, active && styles.chipActive, pressed && { opacity: 0.7 }]}>
                    {m.online ? <View style={styles.online} accessibilityLabel="在线" /> : null}
                    <MachineIcon machine={m.kind} size={16} color={active ? colors.onInk : colors.ink} />
                    <Text style={[styles.chipText, active && { color: colors.onInk }]}>{m.name}</Text>
                  </Pressable>
                )
              })}
            </ScrollView>
            {filter === 'all' ? null : <ListSectionHeader title={FILTER_TITLE[filter]} />}
          </View>
        }
        ListEmptyComponent={loading ? <View style={{ paddingTop: 40, alignItems: 'center' }}><Spinner /></View> : error ? undefined : <Text style={styles.empty}>没有线程</Text>}
        renderItem={({ item }) => 'title' in item ? <ListSectionHeader title={item.title} />
          : 'more' in item ? <ShowAllRow count={item.more} onPress={() => setAllResolved(true)} />
          : <ThreadRow thread={item} onStopped={reload} />}
      />
      <StatusSwitcher value={filter} onChange={setFilter} bottom={insets.bottom + 12} />
      </>}
    </View>
  )
}

/**
 * A thread (Comma design 13): its status icon, its name (等待你 leads with 等你回复 in orange) and one grey line, the
 * bot that runs it, its Agent (R-78) and the machine icon; a blue dot while it waits on the person.
 */
export function ThreadRow({ thread, onStopped }: { thread: Thread; onStopped?: () => void }) {
  const waiting = thread.status === 'waiting'
  return (
    <ThreadLink thread={thread} onStopped={onStopped} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }]}>
      <View style={styles.rowInner}>
        <View style={styles.rowIcon}><StatusIcon status={thread.group ? GROUP_ICON[thread.group] : thread.status} size={20} /></View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.rowTitle} numberOfLines={1}>{waiting ? <Text style={styles.waitingWord}>等你回复 · </Text> : null}{thread.name}</Text>
          <View style={styles.rowMeta}>
            <Text style={styles.rowMetaText} numberOfLines={1}>{[thread.by, (thread.attempts ?? 1) > 1 ? `第 ${thread.attempts} 次尝试` : null, HARNESS[thread.harness] ?? thread.harness].filter(Boolean).join(' · ')}</Text>
            {thread.device ? <MachineIcon machine={thread.device.kind} size={13} /> : null}
          </View>
        </View>
        {waiting ? <Dot /> : null}
      </View>
    </ThreadLink>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  chips: { paddingHorizontal: 16, paddingBottom: 4, gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 44, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20, backgroundColor: colors.bubble },
  chipActive: { backgroundColor: colors.ink },
  chipText: { fontSize: 15 },
  online: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.success },
  segment: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 },
  row: { marginHorizontal: 10, paddingHorizontal: 10, paddingVertical: 9, borderRadius: 10 },
  rowInner: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowIcon: { width: 22, alignItems: 'center' },
  rowTitle: { fontSize: 17, lineHeight: 22 },
  waitingWord: { color: colors.orange },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 },
  rowMetaText: { fontSize: 13, lineHeight: 18, color: colors.secondary },
  empty: { textAlign: 'center', color: colors.secondary, marginTop: 40 },
  failed: { alignItems: 'center', gap: 10, marginTop: 40 },
  error: { fontSize: 13, color: colors.danger },
})
