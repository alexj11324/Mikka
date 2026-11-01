import { useEffect, useState } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { CircleUser, Plus } from 'lucide-react-native'
import { BotAvatar, Spinner } from '@/components/icons'
import { NavBar, underBar } from '@/components/NavBar'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { shortWhen } from '@/lib/clock'
import { useHome } from '@/lib/home'
import { chatPath } from '@/lib/navigate'
import type { GroupSummary, HomeBot } from '@/lib/types'
import { restartToUpdate, useUpdateReady } from '@/lib/updates'
import { prefetch, useApi, useRefresh } from '@/lib/useApi'
import { colors } from '@/lib/theme'

/**
 * 对话, the app's home (decision 2026-10-31-2330): the Coordinator pinned on
 * top, then every bot and group chat with its last line, newest first; 「+」
 * (top right) opens 新建 Bot and 新建群聊 (the
 * web bot list, R-01). Tapping one opens its chat over the tabs. The bar's
 * menu opens 设置, 插件, 建议 and 任务; its search filters by name.
 */
export default function ChatsScreen() {
  const router = useRouter()
  const home = useHome()
  const groupState = useApi<{ conversations: GroupSummary[] }>(home.data ? `/api/conversations?workspaceId=${home.data.workspace.id}` : null, 30_000)
  const refresh = useRefresh(async () => { await Promise.all([home.reload(), groupState.reload()]) })
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const bots = [...home.data?.bots ?? []]
    .filter(bot => !needle || bot.name.toLowerCase().includes(needle))
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
  // Bots and group chats in one list, newest first.
  const rows: Row[] = [
    ...bots.map(bot => ({ kind: 'bot' as const, bot, at: bot.at ?? '' })),
    ...(groupState.data?.conversations ?? []).filter(group => !needle || group.title.toLowerCase().includes(needle))
      .map(group => ({ kind: 'group' as const, group, at: group.lastMessage?.createdAt ?? group.createdAt })),
  ].sort((a, b) => b.at.localeCompare(a.at))
  const showCoordinator = !needle || 'coordinator'.includes(needle)
  const updateReady = useUpdateReady()
  // The Coordinator's chat and the three latest bots' load ahead, so opening one is not blank while it loads.
  const latest = bots.slice(0, 3).map(bot => bot.id).join()
  useEffect(() => {
    if (!home.data) return
    for (const id of [null, ...latest.split(',').filter(Boolean)]) void prefetch(`/api/mobile/chat${id ? `?bot=${id}` : ''}`)
  }, [Boolean(home.data), latest])

  return (
    <View style={styles.screen}>
      <NavBar
        title="对话"
        large
        search={{ placeholder: '搜索', onChange: setQuery }}
        left={{ icon: 'person.crop.circle', label: '我', web: <CircleUser size={22} color={colors.ink} strokeWidth={1.8} />, onOpen: () => router.push('/settings'),
          items: [
            { label: '设置', icon: 'gearshape', onPress: () => router.push('/settings') },
            { label: '插件', icon: 'puzzlepiece.extension', onPress: () => router.push('/plugins') },
            { label: '建议', icon: 'tray', onPress: () => router.push('/suggestions') },
            { label: '任务', icon: 'checklist', onPress: () => router.push('/tasks') },
          ] }}
        right={{ icon: 'plus', label: '新建', web: <Plus size={22} color={colors.ink} strokeWidth={2} />, onOpen: () => router.push('/new-bot'),
          items: [
            { label: '新建 Bot', icon: 'person.crop.circle.badge.plus', onPress: () => router.push('/new-bot') },
            { label: '新建群聊', icon: 'person.2', onPress: () => router.push('/new-group') },
          ] }}
      />
      <FlatList
        data={rows}
        keyExtractor={row => row.kind === 'bot' ? row.bot.id : row.group.id}
        {...underBar}
        keyboardDismissMode="on-drag"
        refreshControl={<RefreshControl {...refresh} />}
        contentContainerStyle={{ paddingBottom: 24 }}
        ListHeaderComponent={showCoordinator || updateReady ? (
          <View>
          {updateReady ? (
            <Pressable accessibilityRole="button" onPress={restartToUpdate} style={({ pressed }) => [styles.update, pressed && { opacity: 0.6 }]}>
              <Symbol name="arrow.down.circle" size={17} color={colors.accent} />
              <Text style={styles.updateText}>重启以更新</Text>
            </Pressable>
          ) : null}
          {showCoordinator ? <View style={styles.pinned}>
            <Pressable accessibilityRole="button" accessibilityLabel="Coordinator" onPress={() => router.push(chatPath(null))} style={({ pressed }) => [styles.pin, pressed && { opacity: 0.6 }]}>
              <View>
                <BotAvatar size={76} />
                <View style={styles.star}><Symbol name="star.fill" size={11} color="#fff" web={<Text style={styles.starText}>★</Text>} /></View>
              </View>
              <Text style={styles.pinName} numberOfLines={1}>Coordinator</Text>
            </Pressable>
          </View> : null}
          </View>
        ) : undefined}
        ListEmptyComponent={home.loading ? <View style={styles.center}><Spinner /></View>
          : needle && !showCoordinator ? <Text style={styles.note}>没有找到「{query.trim()}」</Text> : undefined}
        renderItem={({ item }) => item.kind === 'bot'
          ? <BotRow bot={item.bot} onPress={() => router.push(chatPath(item.bot.id))} />
          : <GroupRow group={item.group} onPress={() => router.push(`/groups/${item.group.id}`)} />}
      />
    </View>
  )
}

type Row = { kind: 'bot'; bot: HomeBot; at: string } | { kind: 'group'; group: GroupSummary; at: string }

/** A group chat: a people symbol, its name, its last message, and a dot while unread. */
function GroupRow({ group, onPress }: { group: GroupSummary; onPress: () => void }) {
  const unread = Number(group.unreadCount) > 0
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }]}>
      <View style={styles.groupIcon}><Symbol name="person.2.fill" size={22} color={colors.secondary} web={<Text style={styles.groupGlyph}>群</Text>} /></View>
      <View style={styles.body}>
        <View style={styles.top}>
          <Text style={styles.name} numberOfLines={1}>{group.title}</Text>
          <Text style={styles.when}>{shortWhen(group.lastMessage?.createdAt ?? group.createdAt)}</Text>
        </View>
        <View style={styles.top}>
          <Text style={[styles.line, { flex: 1 }]} numberOfLines={1}>{group.lastMessage?.body ?? ''}</Text>
          {unread ? <View style={styles.unread} /> : null}
        </View>
      </View>
    </Pressable>
  )
}

/** Avatar, name, last line and when, as a messaging app's chat list. */
function BotRow({ bot, onPress }: { bot: HomeBot; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }]}>
      <BotAvatar color={bot.color} shape={bot.shape} size={52} />
      <View style={styles.body}>
        <View style={styles.top}>
          <Text style={styles.name} numberOfLines={1}>{bot.name}</Text>
          {bot.working ? <Spinner size={13} /> : bot.at ? <Text style={styles.when}>{shortWhen(bot.at)}</Text> : null}
        </View>
        {bot.line ? <Text style={styles.line} numberOfLines={1}>{bot.line}</Text> : null}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  update: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'center', height: 36, paddingHorizontal: 16, borderRadius: 18, backgroundColor: colors.bubble, marginTop: 4 },
  updateText: { fontSize: 15, color: colors.accent, fontWeight: '600' },
  pinned: { flexDirection: 'row', paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12, gap: 24 },
  pin: { alignItems: 'center', width: 96, gap: 8 },
  star: { position: 'absolute', right: 0, bottom: 0, width: 24, height: 24, borderRadius: 12, backgroundColor: colors.orange, borderWidth: 2, borderColor: colors.page, alignItems: 'center', justifyContent: 'center' },
  starText: { color: '#fff', fontSize: 11 },
  pinName: { fontSize: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 10 },
  body: { flex: 1, minWidth: 0, gap: 3 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { flex: 1, fontSize: 17, fontWeight: '600' },
  when: { fontSize: 13, color: colors.tertiary },
  line: { fontSize: 15, color: colors.secondary },
  center: { paddingTop: 40, alignItems: 'center' },
  groupIcon: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.bubble, alignItems: 'center', justifyContent: 'center' },
  groupGlyph: { fontSize: 18, color: colors.secondary },
  unread: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent },
  note: { textAlign: 'center', color: colors.secondary, marginTop: 32, fontSize: 15 },
})
