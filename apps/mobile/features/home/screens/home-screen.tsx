import { useEffect, useState } from 'react'
import { Pressable, RefreshControl, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { ChevronRight, PanelLeft, SquarePen } from 'lucide-react-native'
import Reanimated, { useAnimatedRef, useScrollOffset } from 'react-native-reanimated'
import { Spinner } from '@/components/icons'
import { NavBar, underBar } from '@/components/NavBar'
import { ReadNotice } from '@/components/ReadNotice'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { useAppDrawer } from '@/features/shell/components/app-drawer'
import { restartToUpdate, useUpdateReady } from '@/lib/updates'
import { prefetch, useRefresh } from '@/lib/useApi'
import { colors } from '@/lib/theme'
import { ChatDragProvider } from '../components/chat-drag'
import { HomeChatRow } from '../components/home-chat-row'
import { PinnedGrid } from '../components/pinned-grid'
import { SectionHeader } from '../components/section-header'
import { homeList, type HomeItem, type SectionId } from '../model/home-list'
import { useHomeChats, type HomeChat } from '../model/use-home-chats'

/**
 * The home screen (#1408 Phase 2): the person's chats. The bar holds the workspace button, which opens the drawer,
 * and 新建; the system search field under it narrows the list by name. Pinned chats sit on top as tiles, then the
 * chats in folding sections (home-list.ts). Each row taps, long-presses, swipes and drags (home-chat-row.tsx).
 */
export function HomeScreen() {
  const router = useRouter()
  const drawer = useAppDrawer()
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const actions = useHomeChats(needle)
  const { chats, loading, error, reload } = actions
  const [collapsed, setCollapsed] = useState<ReadonlySet<SectionId>>(new Set())
  const [openKey, setOpenKey] = useState<string | null>(null)
  const { pinned, items, hidden } = homeList(chats, { searching: Boolean(needle), collapsed })
  const refresh = useRefresh(reload)
  const updateReady = useUpdateReady()
  const list = useAnimatedRef<Reanimated.FlatList<HomeItem<HomeChat>>>()
  const scroll = useScrollOffset(list)
  // The Coordinator's chat and the three latest bots' load ahead, so opening one is not blank while it loads.
  const latest = chats.filter(chat => chat.row.kind === 'bot' && !chat.coordinator).slice(0, 3).map(chat => chat.key).join()
  useEffect(() => {
    for (const id of [null, ...latest.split(',').filter(Boolean)]) void prefetch(`/api/mobile/chat${id ? `?bot=${id}` : ''}`)
  }, [latest])
  const toggle = (id: SectionId) => setCollapsed(current => {
    const next = new Set(current)
    if (!next.delete(id)) next.add(id)
    return next
  })

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
      <ChatDragProvider chats={chats} list={list as never} scroll={scroll} onDrop={order => void actions.reorder(order)}>
        <Reanimated.FlatList<HomeItem<HomeChat>>
          ref={list}
          data={items}
          keyExtractor={item => item.kind === 'section' ? `section:${item.id}` : item.chat.key}
          {...underBar}
          keyboardDismissMode="on-drag"
          onScrollBeginDrag={() => setOpenKey(null)}
          refreshControl={<RefreshControl {...refresh} />}
          contentContainerStyle={{ paddingBottom: 24 }}
          ListHeaderComponent={
            <View>
              <ReadNotice error={error} hasData={chats.length > 0} label="对话列表" onRetry={reload} />
              {updateReady ? (
                <Pressable accessibilityRole="button" onPress={restartToUpdate} style={({ pressed }) => [styles.update, pressed && { opacity: 0.6 }]}>
                  <Symbol name="arrow.down.circle" size={17} color={colors.accent} />
                  <Text style={styles.updateText}>重启以更新</Text>
                </Pressable>
              ) : null}
              <PinnedGrid pinned={pinned} actions={actions} />
            </View>
          }
          ListEmptyComponent={loading && !chats.length ? <View style={styles.center}><Spinner /></View>
            : needle ? <Text style={styles.none}>没有匹配的对话</Text> : undefined}
          ListFooterComponent={!needle && hidden > 0 ? (
            <Pressable accessibilityRole="button" onPress={() => router.push('/hidden-chats')} style={({ pressed }) => [styles.hidden, pressed && { opacity: 0.6 }]}>
              <Symbol name="eye.slash" size={15} color={colors.secondary} />
              <Text style={styles.hiddenText}>隐藏的聊天</Text>
              <Text style={styles.hiddenCount}>{hidden}</Text>
              <ChevronRight size={16} color={colors.tertiary} strokeWidth={2} />
            </Pressable>
          ) : undefined}
          renderItem={({ item }) => item.kind === 'section'
            ? <SectionHeader section={item} onToggle={() => toggle(item.id)} />
            : <HomeChatRow chat={item.chat} actions={actions} openKey={openKey} onOpen={setOpenKey} />}
        />
      </ChatDragProvider>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  update: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'center', height: 36, paddingHorizontal: 16, borderRadius: 18, backgroundColor: colors.bubble, marginTop: 4 },
  updateText: { fontSize: 15, color: colors.accent, fontWeight: '600' },
  center: { paddingTop: 40, alignItems: 'center' },
  none: { paddingTop: 40, textAlign: 'center', fontSize: 15, color: colors.secondary },
  hidden: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 20, marginTop: 12 },
  hiddenText: { flex: 1, fontSize: 15, color: colors.secondary },
  hiddenCount: { fontSize: 15, color: colors.tertiary },
})
