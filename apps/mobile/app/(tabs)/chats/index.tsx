import { useEffect } from 'react'
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Plus } from 'lucide-react-native'
import { ChatRowView, rowKey, useChatRows } from '@/components/ChatList'
import { Avatar, useDrawer } from '@/components/Drawer'
import { BotAvatar, Spinner } from '@/components/icons'
import { NavBar, underBar } from '@/components/NavBar'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { chatPath } from '@/lib/navigate'
import { restartToUpdate, useUpdateReady } from '@/lib/updates'
import { prefetch, useRefresh } from '@/lib/useApi'
import { colors } from '@/lib/theme'

/**
 * 对话, the app's home, as a messaging app's chat list (decision
 * 2026-10-31-2330, Alex's Grok screenshot): no title and no search at the top
 * (search is the tab bar's); the person's avatar (top left) opens the drawer
 * and 「+」 (top right) opens 新建 Bot and 新建群聊. The Coordinator is pinned
 * on top with the bots the person pinned, then every other bot and group chat
 * with its last line, newest first.
 */
export default function ChatsScreen() {
  const router = useRouter()
  const drawer = useDrawer()
  const { rows: all, loading, reload } = useChatRows()
  // Pinned bots sit in the row on top with the Coordinator, not in the list (置顶 on a bot's page).
  const pinned = all.flatMap(row => row.kind === 'bot' && row.bot.pinned ? [row.bot] : [])
  const rows = all.filter(row => !(row.kind === 'bot' && row.bot.pinned))
  const refresh = useRefresh(reload)
  const updateReady = useUpdateReady()
  // The Coordinator's chat and the three latest bots' load ahead, so opening one is not blank while it loads.
  const latest = rows.filter(row => row.kind === 'bot').slice(0, 3).map(rowKey).join()
  useEffect(() => {
    for (const id of [null, ...latest.split(',').filter(Boolean)]) void prefetch(`/api/mobile/chat${id ? `?bot=${id}` : ''}`)
  }, [latest])

  return (
    <View style={styles.screen}>
      <NavBar
        title=""
        left={{ label: '菜单', view: <Avatar size={34} />, onPress: drawer.open }}
        right={{ icon: 'plus', label: '新建', web: <Plus size={22} color={colors.ink} strokeWidth={2} />, onOpen: () => router.push('/new-bot'),
          items: [
            { label: '新建 Bot', icon: 'person.crop.circle.badge.plus', onPress: () => router.push('/new-bot') },
            { label: '新建群聊', icon: 'person.2', onPress: () => router.push('/new-group') },
          ] }}
      />
      <FlatList
        data={rows}
        keyExtractor={rowKey}
        {...underBar}
        refreshControl={<RefreshControl {...refresh} />}
        contentContainerStyle={{ paddingBottom: 24 }}
        ListHeaderComponent={
          <View>
            {updateReady ? (
              <Pressable accessibilityRole="button" onPress={restartToUpdate} style={({ pressed }) => [styles.update, pressed && { opacity: 0.6 }]}>
                <Symbol name="arrow.down.circle" size={17} color={colors.accent} />
                <Text style={styles.updateText}>重启以更新</Text>
              </Pressable>
            ) : null}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.pinned, pinned.length < 2 && { flexGrow: 1, justifyContent: 'center' }]}>
              <Pressable accessibilityRole="button" accessibilityLabel="Coordinator" onPress={() => router.push(chatPath(null))} style={({ pressed }) => [styles.pin, pressed && { opacity: 0.6 }]}>
                <View>
                  <BotAvatar size={96} />
                  <View style={styles.star}><Symbol name="star.fill" size={12} color="#fff" web={<Text style={styles.starText}>★</Text>} /></View>
                </View>
                <Text style={styles.pinName} numberOfLines={1}>Coordinator</Text>
              </Pressable>
              {pinned.map(bot => (
                <Pressable key={bot.id} accessibilityRole="button" accessibilityLabel={bot.name} onPress={() => router.push(chatPath(bot.id))} style={({ pressed }) => [styles.pin, pressed && { opacity: 0.6 }]}>
                  <BotAvatar color={bot.color} shape={bot.shape} size={96} />
                  <Text style={styles.pinName} numberOfLines={1}>{bot.name}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        }
        ListEmptyComponent={loading ? <View style={styles.center}><Spinner /></View> : undefined}
        renderItem={({ item }) => <ChatRowView row={item} onPress={() => router.push(item.kind === 'bot' ? chatPath(item.bot.id) : `/groups/${item.group.id}`)} />}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  update: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'center', height: 36, paddingHorizontal: 16, borderRadius: 18, backgroundColor: colors.bubble, marginTop: 4 },
  updateText: { fontSize: 15, color: colors.accent, fontWeight: '600' },
  pinned: { flexDirection: 'row', paddingHorizontal: 20, paddingTop: 24, paddingBottom: 20, gap: 28 },
  pin: { alignItems: 'center', width: 120, gap: 10 },
  star: { position: 'absolute', right: 2, bottom: 2, width: 28, height: 28, borderRadius: 14, backgroundColor: colors.orange, borderWidth: 3, borderColor: colors.page, alignItems: 'center', justifyContent: 'center' },
  starText: { color: '#fff', fontSize: 12 },
  pinName: { fontSize: 15 },
  center: { paddingTop: 40, alignItems: 'center' },
})
