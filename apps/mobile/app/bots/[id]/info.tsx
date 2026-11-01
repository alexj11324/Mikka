import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import * as WebBrowser from 'expo-web-browser'
import { BotAvatar, Spinner } from '@/components/icons'
import { NavBar, underBar } from '@/components/NavBar'
import { Row } from '@/components/settings'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { ThreadRow } from '@/components/ThreadsScreen'
import { Group } from '@/components/ui'
import { nextWhen } from '@/lib/clock'
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
 * computer, its tasks' PRs and its 例行. A section with nothing in it is left
 * out. The computer's screen opens on the web, where it is drawn.
 */
export default function BotInfo() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const coordinator = id === 'coordinator'
  const bot = useHome().data?.bots.find(item => item.id === id)
  const name = coordinator ? 'Coordinator' : bot?.name ?? ''
  const page = useApi<BotPage>(`/api/mobile/bots/${id}`, 15_000)
  // The Coordinator has no computer (context-panel.tsx).
  const computer = useApi<ComputerStatus>(coordinator ? null : `/api/bots/${id}/computer`, 15_000)
  const refresh = useRefresh(async () => { await Promise.all([page.reload(), computer.reload()]) })
  const threads = page.data?.threads ?? []
  const pullRequests = page.data?.pullRequests ?? []
  const schedules = page.data?.schedules ?? []

  return (
    <View style={{ flex: 1, backgroundColor: colors.grouped }}>
      <NavBar title="" />
      <ScrollView {...underBar} contentContainerStyle={styles.body} refreshControl={<RefreshControl {...refresh} />}>
        <View style={styles.hero}>
          <BotAvatar color={bot?.color} shape={bot?.shape} size={96} />
          <Text style={styles.name}>{name}</Text>
        </View>
        {page.loading && !page.data ? <View style={styles.center}><Spinner /></View> : null}
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
