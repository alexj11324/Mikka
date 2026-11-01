import { useEffect, useState } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { CircleUser } from 'lucide-react-native'
import { BotAvatar, Spinner } from '@/components/icons'
import { NavBar, underBar } from '@/components/NavBar'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { shortWhen } from '@/lib/clock'
import { useHome } from '@/lib/home'
import { chatPath } from '@/lib/navigate'
import type { HomeBot } from '@/lib/types'
import { restartToUpdate, useUpdateReady } from '@/lib/updates'
import { prefetch, useRefresh } from '@/lib/useApi'
import { colors } from '@/lib/theme'

/**
 * 对话, the app's home (decision 2026-10-31-2330): the Coordinator pinned on
 * top, then every bot and group chat with its last line, newest first (the
 * web bot list, R-01). Tapping one opens its chat over the tabs. The bar's
 * menu opens 设置, 插件, 建议 and 任务; its search filters by name.
 */
export default function ChatsScreen() {
  const router = useRouter()
  const home = useHome()
  const refresh = useRefresh(home.reload)
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const bots = [...home.data?.bots ?? []]
    .filter(bot => !needle || bot.name.toLowerCase().includes(needle))
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
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
      />
      <FlatList
        data={bots}
        keyExtractor={bot => bot.id}
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
        renderItem={({ item }) => <BotRow bot={item} onPress={() => router.push(chatPath(item.id))} />}
      />
    </View>
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
  note: { textAlign: 'center', color: colors.secondary, marginTop: 32, fontSize: 15 },
})
