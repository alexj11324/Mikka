import { mobileMessages } from '@/lib/messages'
import { useEffect, useState } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { ChevronRight, Plus } from 'lucide-react-native'
import { Spinner } from '@/components/icons'
import { NavBar, underBar } from '@/components/NavBar'
import { Row } from '@/components/settings'
import { ReadNotice } from '@/components/ReadNotice'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { restartToUpdate, useUpdateReady } from '@/lib/updates'
import { useHome } from '@/lib/home'
import { inboxLive } from '@/lib/live-keys'
import { prefetch, useLiveApi, useRefresh } from '@/lib/useApi'
import { colors, LIST_INSET } from '@/lib/theme'
import { HomeChatRow } from '../components/home-chat-row'
import { PinnedGrid } from '../components/pinned-grid'
import { SectionHeader } from '../components/section-header'
import { homeList, type HomeItem, type SectionId } from '../model/home-list'
import { useHomeChats, type HomeChat } from '../model/use-home-chats'

/**
 * The Bot tab (Comma designs 01–05; decisions/2026-11-07-2045-tasks-only-threads-inside.md): the person's chats, with
 * the title Bot in the top row and + (新建 Bot, 新建群聊) on its right. No workspace menu: workspaces switch only in
 * 设置 › 工作区. Search is its own tab. Pinned chats sit on top as tiles,
 * then the chats in folding sections (home-list.ts). Each row taps, long-presses and swipes (home-chat-row.tsx); nothing drags (Alex 2026-11-07).
 */
export function HomeScreen() {
  const router = useRouter()
  const workspace = useHome().data?.workspace.id
  const counts = useLiveApi<{ count: number }>(workspace ? '/api/inbox?' + new URLSearchParams({ workspaceId: workspace, count: '1' }) : null, () => inboxLive(workspace))
  const actions = useHomeChats('')
  const { chats, loading, error, reload } = actions
  const [collapsed, setCollapsed] = useState<ReadonlySet<SectionId>>(new Set())
  const [openKey, setOpenKey] = useState<string | null>(null)
  const { pinned, items, hidden } = homeList(chats, { searching: false, collapsed })
  const refresh = useRefresh(reload)
  const updateReady = useUpdateReady()
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
        title="Bot"
        topTitle
        right={{ icon: 'plus', label: mobileMessages.Nav.create, web: <Plus size={22} color={colors.ink} strokeWidth={2} />, onOpen: () => router.push({ pathname: '/new-group', params: { purpose: 'conversation' } }),
          items: [
            { label: mobileMessages.Nav.newConversation, icon: 'bubble.left', onPress: () => router.push({ pathname: '/new-group', params: { purpose: 'conversation' } }) },
            { label: mobileMessages.Nav.newBot, icon: 'person.crop.circle.badge.plus', onPress: () => router.push('/new-bot') },
            { label: mobileMessages.Nav.newGroup, icon: 'person.2', onPress: () => router.push('/new-group') },
          ] }}
      />
      <FlatList<HomeItem<HomeChat>>
        data={items}
        keyExtractor={item => item.kind === 'section' ? `section:${item.id}` : item.chat.key}
        {...underBar}
        onScrollBeginDrag={() => setOpenKey(null)}
        refreshControl={<RefreshControl {...refresh} />}
        contentContainerStyle={{ paddingBottom: 24 }}
        ListHeaderComponent={
          <View>
            <ReadNotice error={error} hasData={chats.length > 0} label={mobileMessages.MobileCore.chatList} onRetry={reload} />
            {updateReady ? (
              <Pressable accessibilityRole="button" onPress={restartToUpdate} style={({ pressed }) => [styles.update, pressed && { opacity: 0.6 }]}>
                <Symbol name="arrow.down.circle" size={17} color={colors.accent} />
                <Text style={styles.updateText}>{mobileMessages.MobileCore.restartToUpdate}</Text>
              </Pressable>
            ) : null}
            <Row label={mobileMessages.Nav.inbox} value={counts.data?.count ? String(counts.data.count) : undefined} onPress={() => router.push('/inbox')} />
            <Row label={mobileMessages.ConversationDirectory.title} onPress={() => router.push('/conversations')} />
            <Row label={mobileMessages.ArtifactsPage.category.pullRequests} onPress={() => router.push({ pathname: '/conversations', params: { view: 'pulls' } })} />
            <PinnedGrid pinned={pinned} actions={actions} />
          </View>
        }
        ListEmptyComponent={loading && !chats.length ? <View style={styles.center}><Spinner /></View> : undefined}
        ListFooterComponent={hidden > 0 ? (
          <Pressable accessibilityRole="button" onPress={() => router.push('/hidden-chats')} style={({ pressed }) => [styles.hidden, pressed && { opacity: 0.6 }]}>
            <Symbol name="eye.slash" size={15} color={colors.secondary} />
            <Text style={styles.hiddenText}>{mobileMessages.MobileCore.hiddenChats}</Text>
            <Text style={styles.hiddenCount}>{hidden}</Text>
            <ChevronRight size={16} color={colors.tertiary} strokeWidth={2} />
          </Pressable>
        ) : undefined}
        renderItem={({ item }) => item.kind === 'section'
          ? <SectionHeader section={item} onToggle={() => toggle(item.id)} />
          : <HomeChatRow chat={item.chat} actions={actions} openKey={openKey} onOpen={setOpenKey} />}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  update: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'center', height: 36, paddingHorizontal: 16, borderRadius: 18, backgroundColor: colors.bubble, marginTop: 4 },
  updateText: { fontSize: 15, color: colors.accent, fontWeight: '600' },
  center: { paddingTop: 40, alignItems: 'center' },
  hidden: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: LIST_INSET, marginTop: 12 },
  hiddenText: { flex: 1, fontSize: 15, color: colors.secondary },
  hiddenCount: { fontSize: 15, color: colors.tertiary },
})
