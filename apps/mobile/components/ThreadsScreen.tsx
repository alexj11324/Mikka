import { ReadNotice } from '@/components/ReadNotice'
import { useMemo, useState } from 'react'
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Plus } from 'lucide-react-native'
import { Spinner, StatusIcon } from '@/components/icons'
import { GROUP_ICON } from '@/lib/thread-icon'
import { Text } from '@/components/Text'
import { NavBar, underBar } from '@/components/NavBar'
import type { BotPage, Thread, ThreadGroup, Threads } from '@/lib/types'
import { openChat } from '@/lib/navigate'
import { useLiveApi, useRefresh } from '@/lib/useApi'
import { botPageLive, threadsLive } from '@/lib/live-keys'
import { useHome } from '@/lib/home'
import { colors, LIST_INSET, ROW_SURFACE_INSET } from '@/lib/theme'
import { displayTitle } from '@/lib/display-title'
import { CLOSED_SHOWN, ListSectionHeader, ShowAllRow } from '@/shared/components/list-section'
import { ThreadLink } from '@/shared/components/thread-link'
import { Segmented } from '@/components/Segmented'
import { useTaskRows, type TaskRow } from '@/features/tasks/components/task-list'
import { StatusSwitcher, SWITCHER_SPACE, type ThreadFilter as Filter } from '@/features/threads/components/status-switcher'

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


/**
 * 线程 (Comma designs 13 and 15; Alex 2026-11-06): on the tab, a 线程 | 任务 segment under the large title, then one
 * list. 线程 shows the threads by group, each row its status icon and its title on one line, with the floating status
 * switcher above the tab bar as the only filter. 任务 shows the tasks the same way. Both live in the one scroll view,
 * so the large title folds over the segment and never over a row. A bot's threads, pushed over its chat, are the same
 * list without the segment or the switcher.
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
  const [filter, setFilter] = useState<Filter>('all')
  const [segment, setSegment] = useState<'threads' | 'tasks'>('threads')
  const showTasks = !pushed && segment === 'tasks'
  // The tasks are read only once 任务 is open, as before.
  const tasks = useTaskRows(showTasks)
  const refresh = useRefresh(showTasks ? tasks.reload : reload)

  const list = useMemo(() => (data?.threads ?? []).filter(t => matches(t, filter)).sort((a, b) => rank(a) - rank(b)), [data, filter])
  // 全部: grouped as on the web (R-52); 已解决 shows its first rows until 显示全部.
  const [allResolved, setAllResolved] = useState(false)
  const threadRows: Row[] = filter !== 'all' ? list.map(thread => ({ key: thread.id, thread })) : GROUPS.flatMap((group): Row[] => {
    const items = list.filter(thread => groupOf(thread) === group.id)
    if (!items.length) return []
    const cut = group.id === 'resolved' && !allResolved && items.length > CLOSED_SHOWN
    return [{ key: `h:${group.id}`, title: group.title }, ...(cut ? items.slice(0, CLOSED_SHOWN) : items).map(thread => ({ key: thread.id, thread })), ...(cut ? [{ key: 'more', more: items.length }] : [])]
  })
  const rows: (Row | TaskRow)[] = showTasks ? tasks.rows : threadRows
  const renderThreadRow = (row: Row) => 'thread' in row ? <ThreadRow thread={row.thread} onStopped={reload} />
    : 'more' in row ? <ShowAllRow count={row.more} onPress={() => setAllResolved(true)} />
    : <ListSectionHeader title={row.title} />
  const shownError = showTasks ? tasks.error : error

  return (
    <View style={styles.screen}>
      <NavBar
        back={pushed ? () => router.back() : undefined}
        title={bot ? `${bot.name} 的线程` : '线程'}
        large={!pushed}
        right={{ icon: 'square.and.pencil', label: '新线程', web: <Plus size={20} color={colors.ink} strokeWidth={2} />, onPress: () => openChat({ pathname: '/bots/[id]', params: { id: 'coordinator', compose: '1' } }) }}
      />
      <FlatList<Row | TaskRow>
        data={rows}
        keyExtractor={row => row.key}
        // The sections, their first rows and 显示全部 draw at once rather than ten rows at a time.
        initialNumToRender={40}
        {...underBar}
        refreshControl={<RefreshControl {...refresh} />}
        // Room under the last row for the floating switcher, over the tab bar's own inset.
        contentContainerStyle={{ paddingBottom: insets.bottom + (showTasks || pushed ? 24 : SWITCHER_SPACE) }}
        ListHeaderComponent={
          <View>
            {pushed ? null : (
              <View style={styles.segment}>
                <Segmented options={[{ value: 'threads', label: '线程' }, { value: 'tasks', label: '任务' }]} value={segment} onChange={setSegment} />
              </View>
            )}
            <ReadNotice error={shownError} hasData={Boolean(showTasks ? tasks.data : data)} label={showTasks ? '任务' : '线程'} onRetry={showTasks ? tasks.reload : reload} />
            {!showTasks && filter !== 'all' ? <ListSectionHeader title={FILTER_TITLE[filter]} /> : null}
          </View>
        }
        ListEmptyComponent={(showTasks ? tasks.loading : loading) ? <View style={styles.center}><Spinner /></View>
          : shownError ? undefined : <Text style={styles.empty}>{showTasks ? '没有任务' : '没有线程'}</Text>}
        renderItem={({ item }) => showTasks ? tasks.render(item as TaskRow) : renderThreadRow(item as Row)}
      />
      {showTasks || pushed ? null : <StatusSwitcher value={filter} onChange={setFilter} />}
    </View>
  )
}

type Row = { key: string; thread: Thread } | { key: string; title: string } | { key: string; more: number }

/**
 * A thread on one line (Alex 2026-11-06): a plain bubble and its title, without the issue key or date stamp the title
 * may carry (display-title.ts). The section it sits in names its state, so the row adds no dot. Long press keeps
 * 停止 / 复制 ID.
 */
export function ThreadRow({ thread, onStopped }: { thread: Thread; onStopped?: () => void }) {
  return (
    // The side margin sits on a plain View: on iOS the row's press is inside a Link, which may not pass a style on.
    <View style={styles.row}>
      <ThreadLink thread={thread} onStopped={onStopped} style={({ pressed }) => [styles.rowPress, pressed && { backgroundColor: colors.pressed }]}>
        <View style={styles.rowInner}>
          <View style={styles.rowIcon}><StatusIcon status={thread.group ? GROUP_ICON[thread.group] : thread.status} size={20} plain /></View>
          <Text style={styles.rowTitle} numberOfLines={1}>{displayTitle(thread.name)}</Text>
        </View>
      </ThreadLink>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  segment: { paddingHorizontal: LIST_INSET, paddingTop: 4, paddingBottom: 12 },
  row: { marginHorizontal: ROW_SURFACE_INSET },
  rowPress: { borderRadius: 10 },
  rowInner: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 52, paddingHorizontal: LIST_INSET - ROW_SURFACE_INSET },
  rowIcon: { width: 22, alignItems: 'center' },
  rowTitle: { flex: 1, minWidth: 0, fontSize: 17, lineHeight: 22 },
  center: { paddingTop: 40, alignItems: 'center' },
  empty: { textAlign: 'center', color: colors.secondary, marginTop: 40, fontSize: 15 },
})
