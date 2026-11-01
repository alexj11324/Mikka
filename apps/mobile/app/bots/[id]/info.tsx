import { Alert, RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import * as WebBrowser from 'expo-web-browser'
import { BotAvatar, Spinner } from '@/components/icons'
import { NavBar, underBar } from '@/components/NavBar'
import { Row, ToggleRow } from '@/components/settings'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { ThreadRow } from '@/components/ThreadsScreen'
import { Group } from '@/components/ui'
import { api } from '@/lib/api'
import { nextWhen, shortWhen } from '@/lib/clock'
import { useHome } from '@/lib/home'
import type { BotPage, ComputerStatus } from '@/lib/types'
import { useApi, useRefresh } from '@/lib/useApi'
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
 * the chat (components/nav/context-panel.tsx): its latest threads, its
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
  const page = useApi<BotPage>(`/api/mobile/bots/${id}`, 15_000)
  // The Coordinator's computer is its bot row's, like any bot's (context-panel.tsx).
  const computerBot = coordinator ? bots?.find(item => item.coordinator)?.id : id
  const computer = useApi<ComputerStatus>(computerBot ? `/api/bots/${computerBot}/computer` : null, 15_000)
  const refresh = useRefresh(async () => { await Promise.all([page.reload(), computer.reload()]) })
  const threads = page.data?.threads ?? []
  const pullRequests = page.data?.pullRequests ?? []
  const schedules = page.data?.schedules ?? []
  const library = page.data?.library ?? []
  const home = useHome()
  // 置顶 and 通知 change at once, then save; the next load has the server's word.
  const setPreference = async (change: { pinned?: boolean; muted?: boolean }) => {
    page.setData(current => current && { ...current, ...change })
    try {
      await api(`/api/mobile/bots/${id}`, { method: 'PATCH', body: change })
      if (change.pinned !== undefined) await home.reload()
    } finally { void page.reload() }
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
          <BotAvatar color={bot?.color} shape={bot?.shape} size={96} />
          <Text style={styles.name}>{name}</Text>
        </View>
        {page.loading && !page.data ? <View style={styles.center}><Spinner /></View> : null}
        {page.data ? (
          <Group>
            <ToggleRow label="置顶" value={page.data.pinned} onChange={pinned => void setPreference({ pinned })} />
            <ToggleRow label="通知" value={!page.data.muted} onChange={on => void setPreference({ muted: !on })} />
          </Group>
        ) : null}
        {threads.length ? (
          <Group label="线程">
            {threads.slice(0, SHOWN).map(thread => <ThreadRow key={thread.id} thread={thread} onPress={() => router.push(`/thread/${thread.id}`)} />)}
            {threads.length > SHOWN ? <Row label="全部线程" value={String(threads.length)} onPress={() => router.push(`/bots/${id}/threads`)} /> : null}
          </Group>
        ) : null}
        {computer.data ? (
          <Group>
            <Row icon={<Symbol name="desktopcomputer" size={19} />} label="电脑" value={computerLabel(computer.data)} onPress={() => void openOnWeb(webChatPath(id))} />
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
})
