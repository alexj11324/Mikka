import { useEffect, useState } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { PanelLeft, SquarePen } from 'lucide-react-native'
import { ChatRowView, rowKey, useChatRows, type ChatRow } from '@/components/ChatList'
import { BotAvatar, Spinner } from '@/components/icons'
import { NavBar, underBar } from '@/components/NavBar'
import { ReadNotice } from '@/components/ReadNotice'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { useAppDrawer } from '@/features/shell/components/app-drawer'
import { botPath } from '@/lib/pins'
import { restartToUpdate, useUpdateReady } from '@/lib/updates'
import { prefetch, useRefresh } from '@/lib/useApi'
import { colors } from '@/lib/theme'
import { homeSections, type HomeItem } from '../model/home-sections'

const open = (router: ReturnType<typeof useRouter>, row: ChatRow) => router.push(row.kind === 'bot' ? botPath(row.bot) : `/groups/${row.group.id}`)

/**
 * The home screen (#1408 Phase 2): the person's chats. The bar holds the workspace button, which opens the drawer,
 * and 新建; the system search field under it narrows the list by name. Pinned bots sit on top as tiles, then the
 * chats in sections (home-sections.ts).
 */
export function HomeScreen() {
  const router = useRouter()
  const drawer = useAppDrawer()
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const { rows, loading, error, reload } = useChatRows(needle)
  const { pinned, items } = homeSections(rows, Boolean(needle))
  const refresh = useRefresh(reload)
  const updateReady = useUpdateReady()
  // The Coordinator's chat and the three latest bots' load ahead, so opening one is not blank while it loads.
  const latest = rows.filter(row => row.kind === 'bot' && !row.bot.coordinator).slice(0, 3).map(rowKey).join()
  useEffect(() => {
    for (const id of [null, ...latest.split(',').filter(Boolean)]) void prefetch(`/api/mobile/chat${id ? `?bot=${id}` : ''}`)
  }, [latest])

  return (
    <View style={styles.screen}>
      <NavBar
        title=""
        left={{ icon: 'sidebar.left', label: '工作区', web: <PanelLeft size={22} color={colors.ink} strokeWidth={2} />, onPress: drawer.open }}
        right={{ icon: 'square.and.pencil', label: '新建', web: <SquarePen size={20} color={colors.ink} strokeWidth={2} />, onOpen: () => router.push('/new-bot'),
          items: [
            { label: '新建 Bot', icon: 'person.crop.circle.badge.plus', onPress: () => router.push('/new-bot') },
            { label: '新建群聊', icon: 'person.2', onPress: () => router.push('/new-group') },
          ] }}
        search={{ placeholder: '搜索', onChange: setQuery }}
      />
      <FlatList<HomeItem<ChatRow>>
        data={items}
        keyExtractor={item => item.kind === 'section' ? `section:${item.id}` : rowKey(item.row)}
        {...underBar}
        keyboardDismissMode="on-drag"
        refreshControl={<RefreshControl {...refresh} />}
        contentContainerStyle={{ paddingBottom: 24 }}
        ListHeaderComponent={
          <View>
            <ReadNotice error={error} hasData={rows.length > 0} label="对话列表" onRetry={reload} />
            {updateReady ? (
              <Pressable accessibilityRole="button" onPress={restartToUpdate} style={({ pressed }) => [styles.update, pressed && { opacity: 0.6 }]}>
                <Symbol name="arrow.down.circle" size={17} color={colors.accent} />
                <Text style={styles.updateText}>重启以更新</Text>
              </Pressable>
            ) : null}
            {pinned.length ? (
              <View style={styles.pins}>
                {pinned.map(row => row.kind === 'bot' ? (
                  <Pressable key={row.bot.id} accessibilityRole="button" accessibilityLabel={row.bot.name} onPress={() => open(router, row)} style={({ pressed }) => [styles.pin, pressed && { opacity: 0.6 }]}>
                    <View>
                      <BotAvatar color={row.bot.color} shape={row.bot.shape} size={64} />
                      <View style={styles.star}><Symbol name="star.fill" size={10} color={colors.onAccent} web={<Text style={styles.starText}>★</Text>} /></View>
                    </View>
                    <Text style={styles.pinName} numberOfLines={1}>{row.bot.name}</Text>
                  </Pressable>
                ) : null)}
              </View>
            ) : null}
          </View>
        }
        ListEmptyComponent={loading && !rows.length ? <View style={styles.center}><Spinner /></View>
          : needle ? <Text style={styles.none}>没有匹配的对话</Text> : undefined}
        renderItem={({ item }) => item.kind === 'section'
          ? <View style={styles.section}><Text accessibilityRole="header" style={styles.sectionTitle}>{item.title}</Text><Text style={styles.sectionCount}>{item.count}</Text></View>
          : <ChatRowView row={item.row} onPress={() => open(router, item.row)} />}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  update: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'center', height: 36, paddingHorizontal: 16, borderRadius: 18, backgroundColor: colors.bubble, marginTop: 4 },
  updateText: { fontSize: 15, color: colors.accent, fontWeight: '600' },
  pins: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 8, paddingTop: 12, paddingBottom: 8, rowGap: 16 },
  pin: { width: '25%', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  star: { position: 'absolute', right: -2, bottom: -2, width: 22, height: 22, borderRadius: 11, backgroundColor: colors.orange, borderWidth: 2, borderColor: colors.page, alignItems: 'center', justifyContent: 'center' },
  starText: { color: colors.onAccent, fontSize: 10 },
  pinName: { fontSize: 12.5, lineHeight: 16, textAlign: 'center' },
  section: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 20, paddingRight: 16, paddingTop: 14, paddingBottom: 4 },
  sectionTitle: { fontSize: 13, lineHeight: 18, fontWeight: '500', color: colors.secondary },
  sectionCount: { fontSize: 13, lineHeight: 18, color: colors.tertiary },
  center: { paddingTop: 40, alignItems: 'center' },
  none: { paddingTop: 40, textAlign: 'center', fontSize: 15, color: colors.secondary },
})
