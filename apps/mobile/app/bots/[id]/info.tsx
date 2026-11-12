import { ReadNotice } from '@/components/ReadNotice'
import { useRef, useState } from 'react'
import { Alert, RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import * as WebBrowser from 'expo-web-browser'
import { BotAvatar, Spinner } from '@/components/icons'
import { NavBar, underBar } from '@/components/NavBar'
import { Row, ToggleRow } from '@/components/settings'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { useTasks } from '@/features/tasks/components/task-list'
import { TaskStateIcon } from '@/features/tasks/components/task-icons'
import { menuTasks } from '@/features/chat/model/chat-header-menu'
import { rowState } from '@/features/tasks/model/task-groups'
import { displayTitle } from '@/lib/display-title'
import { Group } from '@/components/ui'
import { api } from '@/lib/api'
import { saveOptimistic } from '@/lib/optimistic'
import { nextWhen, shortWhen } from '@/lib/clock'
import { useHome } from '@/lib/home'
import type { BotPage, ComputerStatus } from '@/lib/types'
import { useLiveApi, useRefresh } from '@/lib/useApi'
import { botPageLive, computerLive } from '@/lib/live-keys'
import { openOnWeb, webChatPath } from '@/lib/web'
import { colors } from '@/lib/theme'

const SHOWN = 5
const PR_GROUP = { review: '等待审查', running: '进行中', merged: '已合并' } as const

/** 电脑's state in the web's words (messages Computer.status). */
function computerLabel(state: ComputerStatus) {
  if (state.machine === 'running') return state.control === 'user' ? '你在操作' : state.control === 'agent' ? 'Bot 操作中' : '运行中'
  return { sleeping: '休眠中', waking: '唤醒中', error: '出错' }[state.machine]
}

/**
 * A bot's page, opened from its name at the top of its chat (as in Grok and
 * WhatsApp): the avatar and name, then what the web's right panel shows beside
 * the chat (components/nav/context-panel.tsx): its latest tasks, its
 * computer, its tasks' PRs, its 资料库 and its 例行, with the person's 置顶
 * and 通知 for it. A section with nothing in it is left out. The computer's
 * screen and an HTML document open on the web, where they are drawn.
 */
export default function BotInfo() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const coordinator = id === 'coordinator'
  const bots = useHome().data?.bots
  const bot = bots?.find(item => item.id === id)
  const name = coordinator ? 'Coordinator' : bot?.name ?? ''
  const homeData = useHome().data
  // The Coordinator's computer is its bot row's, like any bot's (context-panel.tsx).
  const computerBot = coordinator ? bots?.find(item => item.coordinator)?.id : id
  const page = useLiveApi<BotPage>(`/api/mobile/bots/${id}`, current => botPageLive(current, computerBot, homeData?.live?.workspaceId, homeData?.workspace.id))
  const computer = useLiveApi<ComputerStatus>(computerBot ? `/api/bots/${computerBot}/computer` : null, current => computerLive(current, computerBot))
  const refresh = useRefresh(async () => { await Promise.all([page.reload(), computer.reload(), allTasks.reload()]) })
  // Its tasks, waiting ones first (2026-11-07: lists show tasks; a thread opens inside its task).
  const allTasks = useTasks(Boolean(computerBot), computerBot)
  const ownTasks = allTasks.paging.items.filter(task => computerBot && (task.dispatchedBy === computerBot || task.bot?.id === computerBot))
  const tasks = menuTasks(ownTasks, computerBot, SHOWN)
  const pullRequests = page.data?.pullRequests ?? []
  const schedules = page.data?.schedules ?? []
  const library = page.data?.library ?? []
  const home = useHome()
  // 置顶 and 通知 change at once, then save; a save that fails puts the switch back and says so.
  const saving = useRef(false)
  const [busy, setBusy] = useState(false)
  const [unsaved, setUnsaved] = useState<'置顶' | '通知' | null>(null)
  const setPreference = async (change: { pinned?: boolean; muted?: boolean }) => {
    if (saving.current) return
    saving.current = true; setBusy(true)
    const before = page.data && { pinned: page.data.pinned, muted: page.data.muted }
    setUnsaved(null)
    const saved = await saveOptimistic(
      () => page.setData(current => current && { ...current, ...change }),
      () => api(`/api/mobile/bots/${id}`, { method: 'PATCH', body: change }),
      () => page.setData(current => current && before ? { ...current, ...before } : current),
    )
    if (!saved) setUnsaved(change.pinned !== undefined ? '置顶' : '通知')
    else {
      // A poll started during the PATCH may still contain the old preference.
      // Confirm the saved fields and invalidate that older read.
      page.setData(current => current && { ...current, ...change })
      if (change.pinned !== undefined) await home.reload()
    }
    saving.current = false; setBusy(false)
  }
  // A long press deletes one of the person's own files, after the system's confirmation (R-51, decision 2026-11-01-2255).
  const deleteFile = (item: BotPage['library'][number]) => Alert.alert(`删除「${item.title}」？`, undefined, [
    { text: '取消', style: 'cancel' },
    { text: '删除', style: 'destructive', onPress: () => void (async () => {
      try {
        await api(`/api/mobile/artifacts/${item.id}`, { method: 'DELETE' })
        page.setData(current => current && { ...current, library: current.library.filter(file => file.id !== item.id) })
      } catch { Alert.alert(`「${item.title}」未删除`) } finally { void page.reload() }
    })() },
  ])
  const openArtifact = (item: BotPage['library'][number]) => item.kind === 'html'
    ? void openOnWeb(`/api/artifacts/${item.id}/versions/${item.version}/frame`)
    : router.push({ pathname: '/artifact/[id]', params: { id: item.id, v: String(item.version), title: item.title } })

  return (
    <View style={{ flex: 1, backgroundColor: colors.grouped }}>
      <NavBar title="" />
      <ScrollView {...underBar} contentContainerStyle={styles.body} refreshControl={<RefreshControl {...refresh} />}>
        <View style={styles.hero}>
          <BotAvatar id={id} coordinator={bot?.coordinator} color={bot?.color} shape={bot?.shape} size={96} />
          {name ? <Text style={styles.name}>{name}</Text> : <Spinner />}
        </View>
        <ReadNotice error={page.error} hasData={Boolean(page.data)} label="Bot 资料" onRetry={page.reload} />
        <ReadNotice error={computer.error} hasData={Boolean(computer.data)} label="电脑状态" onRetry={computer.reload} />
        {page.loading && !page.data ? <View style={styles.center}><Spinner /></View> : null}
        {page.data ? (
          <Group>
            <ToggleRow label="置顶" value={page.data.pinned} disabled={busy} onChange={pinned => void setPreference({ pinned })} />
            <ToggleRow label="通知" value={!page.data.muted} disabled={busy} onChange={on => void setPreference({ muted: !on })} />
          </Group>
        ) : null}
        {busy ? <Text accessibilityLiveRegion="polite" style={{ color: colors.secondary, marginBottom: 16 }}>正在保存</Text> : null}
        {unsaved ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.unsaved}>{unsaved}没保存，请稍后重试</Text> : null}
        {tasks.length ? (
          <Group label="任务">
            {tasks.map(task => <Row key={task.id} icon={<TaskStateIcon state={rowState(task).state} status={task.status} />} label={displayTitle(task.title)} value={task.identifier ?? undefined} onPress={() => router.push(`/task/${task.id}`)} />)}
            {ownTasks.length > SHOWN ? <Row label="全部任务" value={String(ownTasks.length)} onPress={() => router.push(`/bots/${id}/tasks`)} /> : null}
          </Group>
        ) : null}
        {computer.data ? (
          <Group>
            <Row icon={<Symbol name="desktopcomputer" size={19} />} label="电脑" value={computerLabel(computer.data)} onPress={() => { const target = webChatPath(id === 'coordinator' ? null : id, home.data?.workspace.id); if (target) void openOnWeb(target) }} />
          </Group>
        ) : null}
        {pullRequests.length ? (
          <Group label="PR">
            {pullRequests.map(pr => (
              <Row key={pr.url} label={`#${pr.number}${pr.title ? ` ${pr.title}` : ''}`} value={PR_GROUP[pr.group]}
                onPress={() => void WebBrowser.openBrowserAsync(pr.url)} trailing={<Symbol name="arrow.up.right" size={12} color={colors.tertiary} />} />
            ))}
          </Group>
        ) : null}
        {library.length ? (
          <Group label="资料库">
            {library.map(item => (
              <Row key={item.id} icon={<Symbol name={item.kind === 'html' ? 'globe' : 'doc.text'} size={19} />} label={item.title} value={shortWhen(item.updatedAt)} onPress={() => openArtifact(item)} onLongPress={() => deleteFile(item)} />
            ))}
          </Group>
        ) : null}
        {schedules.length ? (
          <Group label="例行">
            {schedules.map(schedule => (
              <Row key={schedule.id} icon={<Symbol name="clock" size={19} />} label={schedule.title}
                value={schedule.status === 'paused' ? '已暂停' : schedule.nextAt ? nextWhen(schedule.nextAt) : undefined} />
            ))}
          </Group>
        ) : null}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  body: { padding: 16 },
  hero: { alignItems: 'center', gap: 12, marginTop: 8, marginBottom: 28 },
  name: { fontSize: 26, fontWeight: '700' },
  center: { paddingVertical: 24, alignItems: 'center' },
  unsaved: { fontSize: 13, color: colors.danger, marginTop: -12, marginBottom: 20, marginLeft: 16 },
})
