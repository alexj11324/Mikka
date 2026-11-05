import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Alert, FlatList, Platform, Pressable, RefreshControl, StyleSheet, View, type HostInstance } from 'react-native'
import { useRouter, type Href } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import { PanelLeft, SquarePen } from 'lucide-react-native'
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated'
import { ChatRowView, rowKey, useChatRows, type ChatRow } from '@/components/ChatList'
import { BotAvatar, Spinner } from '@/components/icons'
import { NavBar, underBar } from '@/components/NavBar'
import { ReadNotice } from '@/components/ReadNotice'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { useAppDrawer } from '@/features/shell/components/app-drawer'
import { api } from '@/lib/api'
import { tap, warn } from '@/lib/haptics'
import { useHome } from '@/lib/home'
import { saveOptimistic } from '@/lib/optimistic'
import { botPath } from '@/lib/pins'
import { restartToUpdate, useUpdateReady } from '@/lib/updates'
import { prefetch, useRefresh } from '@/lib/useApi'
import { colors } from '@/lib/theme'
import type { WaitingMark } from '@/lib/types'
import { AvatarBadge } from '../components/avatar-badge'
import { HomeMenuSheet } from '../components/home-menu-sheet'
import { HomeRowFrame, NATIVE_ROW_MENU } from '../components/home-row-frame'
import { SectionHeader } from '../components/section-header'
import { homeSections } from '../model/home-sections'
import { chatMenu, type ChatMenuAction } from '../model/chat-menu'
import { shownUnread, type ReadMark } from '../model/chat-read'
import { pinOutcome } from '../model/chat-swipe'
import {
  applyDrop, collapseSections, edgeScroll, listBands, orderedRows, pinColumn, pinIndex, dropAt, slotContentY,
  type DropTarget, type HomeListItem, type OrderRow, type SectionId,
} from '../model/chat-order'
import { useHomeList } from '../model/use-home-list'

/** Mikka does not cap how many chats can be pinned. The warning haptic fires only when a cap refuses one. */
const PIN_LIMIT: number | null = null

type Shaped = ChatRow & OrderRow

const rowId = (row: ChatRow) => row.kind === 'bot' ? row.bot.id : row.group.id
const rowName = (row: ChatRow) => row.kind === 'bot' ? row.bot.name : row.group.title
const rowHref = (row: ChatRow) => row.kind === 'bot' ? botPath(row.bot) : `/groups/${row.group.id}`
const waitingOf = (row: ChatRow): WaitingMark | null => row.kind === 'bot' ? row.bot.waiting ?? null : null

function shape(row: ChatRow): Shaped {
  if (row.kind === 'bot') return { ...row, id: row.bot.id, pinned: Boolean(row.bot.pinned), working: row.bot.working, coordinator: row.bot.coordinator }
  return { ...row, id: row.group.id, pinned: false, working: false }
}

function unreadOf(row: ChatRow, read: Record<string, ReadMark>): number {
  const server = row.kind === 'group' ? Number(row.group.unreadCount) || 0 : row.bot.unread ?? 0
  return shownUnread(server, row.at, read[rowId(row)])
}

/**
 * The home screen (#1408): the person's chats. A long press opens the chat's menu, a swipe toward the leading edge
 * pins a bot, and a hold then a drag reorders it. Pinned bots sit on top as tiles.
 */
export function HomeScreen() {
  const router = useRouter()
  const drawer = useAppDrawer()
  const home = useHome()
  const arrangement = useHomeList()
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const searching = Boolean(needle)
  const { rows, loading, error, reload } = useChatRows(needle)
  const shaped = useMemo(() => rows.map(shape), [rows])
  const ordered = useMemo(() => searching ? shaped : orderedRows(shaped, arrangement.save.order), [arrangement.save.order, searching, shaped])
  const { pinned, items } = homeSections(ordered, searching)
  const shown = useMemo(() => collapseSections(items, new Set(searching ? [] : arrangement.save.collapsed), row => unreadOf(row, arrangement.save.read)), [arrangement.save.collapsed, arrangement.save.read, items, searching])
  const [headerAbove, setHeaderAbove] = useState(0)
  const sectionBands = useMemo(() => {
    const list: { id: SectionId; rows: number; collapsed: boolean }[] = []
    for (const item of shown) {
      if (item.kind === 'section' && (item.id === 'working' || item.id === 'bots' || item.id === 'groups')) list.push({ id: item.id, rows: 0, collapsed: item.collapsed })
      else if (item.kind === 'row' && list.length && !list[list.length - 1].collapsed) list[list.length - 1].rows += 1
    }
    return list
  }, [shown])
  const bands = useMemo(() => listBands(headerAbove, searching ? 0 : pinned.length, searching ? [] : sectionBands), [headerAbove, pinned.length, searching, sectionBands])
  const refresh = useRefresh(reload)
  const updateReady = useUpdateReady()
  const latest = rows.filter(row => row.kind === 'bot' && !row.bot.coordinator).slice(0, 3).map(rowKey).join()
  useEffect(() => {
    for (const id of [null, ...latest.split(',').filter(Boolean)]) void prefetch(`/api/mobile/chat${id ? `?bot=${id}` : ''}`)
  }, [latest])

  const listRef = useRef<FlatList<HomeListItem<Shaped>>>(null)
  const listBox = useRef<HostInstance>(null)
  const scrollY = useRef(0)
  const listFrame = useRef({ x: 0, y: 0, height: 0, width: 0 })
  const bandsRef = useRef(bands)
  bandsRef.current = bands
  const orderedRef = useRef(ordered)
  orderedRef.current = ordered
  const dropRef = useRef<DropTarget | null>(null)
  const dir = useRef<-1 | 0 | 1>(0)
  const dragging = useRef<string | null>(null)
  const dragX = useSharedValue(0)
  const dragY = useSharedValue(0)
  const ghostOn = useSharedValue(0)
  const lineY = useSharedValue(0)
  const lineOn = useSharedValue(0)
  const [dragId, setDragId] = useState<string | null>(null)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [closeToken, setCloseToken] = useState(0)

  useEffect(() => {
    if (!dragId) return
    let frame = 0
    const tick = () => {
      if (dir.current !== 0 && listRef.current) {
        const next = Math.max(0, scrollY.current + dir.current * 10)
        scrollY.current = next
        listRef.current.scrollToOffset({ offset: next, animated: false })
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [dragId])

  const savePin = useCallback(async (row: Extract<ChatRow, { kind: 'bot' }>, next: boolean) => {
    const count = orderedRef.current.filter(item => item.kind === 'bot' && item.bot.pinned).length
    if (next && pinOutcome(false, count, PIN_LIMIT) === 'limit') { warn(); return }
    const id = row.bot.coordinator ? 'coordinator' : row.bot.id
    const before = home.data
    const saved = await saveOptimistic(
      () => home.setData(current => current && { ...current, bots: current.bots.map(bot => bot.id === row.bot.id ? { ...bot, pinned: next } : bot) }),
      () => api(`/api/mobile/bots/${id}`, { method: 'PATCH', body: { pinned: next } }),
      () => { if (before) home.setData(before) },
    )
    if (!saved) Alert.alert('置顶未保存，请稍后重试。')
  }, [home])

  const openChat = useCallback((row: ChatRow) => {
    arrangement.setRead(rowId(row), { at: row.at, state: 'read' })
    if (row.kind === 'group' && row.group.lastMessage) void api(`/api/conversations/${row.group.id}/read`, { method: 'POST', body: { messageId: row.group.lastMessage.id } }).catch(() => undefined)
    router.push(rowHref(row) as Href)
  }, [arrangement, router])

  const runAction = useCallback(async (row: ChatRow, action: ChatMenuAction) => {
    if (action === 'copy-id') { await Clipboard.setStringAsync(rowId(row)); tap(); return }
    if (action === 'info' && row.kind === 'bot') { router.push(`/bots/${row.bot.coordinator ? 'coordinator' : row.bot.id}/info` as Href); return }
    if (action === 'read' || action === 'unread') {
      if (action === 'read' && row.kind === 'group' && row.group.lastMessage) {
        try { await api(`/api/conversations/${row.group.id}/read`, { method: 'POST', body: { messageId: row.group.lastMessage.id } }) }
        catch { Alert.alert('已读未保存，请稍后重试。'); return }
      }
      arrangement.setRead(rowId(row), { at: row.at, state: action === 'read' ? 'read' : 'unread' })
      return
    }
    if (row.kind === 'bot' && (action === 'pin' || action === 'unpin')) await savePin(row, action === 'pin')
  }, [arrangement, router, savePin])

  const onDragStart = useCallback((id: string, x: number, y: number) => {
    if (searching) return
    dragging.current = id
    dragX.set(x)
    dragY.set(y)
    ghostOn.set(1)
    setDragId(id)
    setMenuId(null)
    setOpenId(null)
    setCloseToken(token => token + 1)
    drawer.hold(true)
    tap()
  }, [dragX, dragY, drawer, ghostOn, searching])

  const onDragMove = useCallback((id: string, x: number, y: number) => {
    if (dragging.current !== id) return
    const frame = listFrame.current
    const contentY = scrollY.current + (y - frame.y)
    const row = orderedRef.current.find(item => item.id === id)
    const rough = row ? dropAt(bandsRef.current, contentY, row.kind) : null
    const target = rough?.zone === 'pins' ? { zone: 'pins' as const, index: pinIndex(rough.index, pinColumn(x - frame.x, frame.width), pinned.length) } : rough
    const legal = target && row && applyDrop(orderedRef.current, id, target) ? target : null
    dropRef.current = legal
    const at = legal ? slotContentY(bandsRef.current, legal) : null
    lineOn.set(at === null ? 0 : 1)
    if (at !== null) lineY.set(frame.y + at - scrollY.current)
    dir.current = edgeScroll(y, frame.y, frame.height)
  }, [lineOn, lineY, pinned.length])

  const onDragEnd = useCallback((id: string) => {
    if (dragging.current !== id) return
    dragging.current = null
    ghostOn.set(0)
    lineOn.set(0)
    dir.current = 0
    drawer.hold(false)
    setDragId(null)
    const target = dropRef.current
    dropRef.current = null
    const row = orderedRef.current.find(item => item.id === id)
    const result = target && row ? applyDrop(orderedRef.current, id, target) : null
    if (!result) return
    arrangement.setOrder(result.order)
    if (result.pin !== null && row?.kind === 'bot') void savePin(row, result.pin)
  }, [arrangement, drawer, ghostOn, lineOn, savePin])

  const onCommit = useCallback((row: Shaped) => {
    if (row.kind !== 'bot') return
    const count = orderedRef.current.filter(item => item.kind === 'bot' && item.bot.pinned).length
    const outcome = pinOutcome(Boolean(row.bot.pinned), count, PIN_LIMIT)
    if (outcome === 'limit') { warn(); return }
    void savePin(row, outcome === 'pin')
  }, [savePin])

  const frameFor = (row: Shaped, swipe: boolean, tile: ReactNode, pinTile = false) => (
    <HomeRowFrame
      key={row.id}
      id={row.id} href={rowHref(row)} name={rowName(row)}
      actions={chatMenu({ kind: row.kind, pinned: Boolean(row.kind === 'bot' && row.bot.pinned), unread: unreadOf(row, arrangement.save.read) })}
      swipe={swipe} pinned={Boolean(row.kind === 'bot' && row.bot.pinned)} open={openId === row.id} closeToken={closeToken}
      dragX={dragX} dragY={dragY} dimmed={dragId === row.id}
      onPress={() => openChat(row)} onLongPress={() => setMenuId(row.id)} onAction={action => void runAction(row, action)}
      onCommit={() => onCommit(row)} onReveal={setOpenId}
      onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd} tile={pinTile}
    >{tile}</HomeRowFrame>
  )

  const dragRow = ordered.find(row => row.id === dragId) ?? null
  const menuRow = ordered.find(row => row.id === menuId) ?? null
  const ghost = useAnimatedStyle(() => ({ opacity: ghostOn.get(), transform: [{ translateX: dragX.get() - 32 }, { translateY: dragY.get() - 32 }] }))
  const line = useAnimatedStyle(() => ({ opacity: lineOn.get(), transform: [{ translateY: lineY.get() }] }))

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
      <View ref={listBox} style={styles.list} onLayout={() => listBox.current?.measureInWindow((x, y, width, height) => { listFrame.current = { x, y, width, height } })}>
      <FlatList
        ref={listRef}
        style={styles.list}
        data={shown}
        keyExtractor={item => item.kind === 'section' ? `section:${item.id}` : rowKey(item.row)}
        extraData={`${dragId}:${openId}:${arrangement.save.collapsed.join()}`}
        {...underBar}
        keyboardDismissMode="on-drag"
        onScroll={event => { scrollY.current = event.nativeEvent.contentOffset.y }}
        scrollEventThrottle={16}
        refreshControl={<RefreshControl {...refresh} />}
        contentContainerStyle={{ paddingBottom: 24 }}
        ListHeaderComponent={
          <View>
            <View onLayout={event => setHeaderAbove(height => event.nativeEvent.layout.height === height ? height : event.nativeEvent.layout.height)}>
              <ReadNotice error={error} hasData={rows.length > 0} label="对话列表" onRetry={reload} />
              {updateReady ? (
                <Pressable accessibilityRole="button" onPress={restartToUpdate} style={({ pressed }) => [styles.update, pressed && { opacity: 0.6 }]}>
                  <Symbol name="arrow.down.circle" size={17} color={colors.accent} />
                  <Text style={styles.updateText}>重启以更新</Text>
                </Pressable>
              ) : null}
            </View>
            {pinned.length && !searching ? (
              <View style={styles.pins}>
                {pinned.map(row => row.kind === 'bot' ? frameFor(row, false, (
                  <View key={row.bot.id} style={styles.pinFace}>
                    <View>
                      <BotAvatar color={row.bot.color} shape={row.bot.shape} size={64} />
                      <AvatarBadge waiting={waitingOf(row)} unread={unreadOf(row, arrangement.save.read)} />
                      <View style={styles.star}><Symbol name="star.fill" size={10} color={colors.onAccent} web={<Text style={styles.starText}>★</Text>} /></View>
                    </View>
                    <Text style={styles.pinName} numberOfLines={1}>{row.bot.name}</Text>
                  </View>
                ), true) : null)}
              </View>
            ) : null}
          </View>
        }
        ListEmptyComponent={loading && !rows.length ? <View style={styles.center}><Spinner /></View>
          : needle ? <Text style={styles.none}>没有匹配的对话</Text> : undefined}
        renderItem={({ item }) => item.kind === 'section'
          ? <SectionHeader title={item.title} count={item.count} unread={item.unread} collapsed={item.collapsed} onPress={() => arrangement.toggleSection(item.id)} />
          : frameFor(item.row, item.row.kind === 'bot', (
            <ChatRowView row={item.row} badge={<AvatarBadge waiting={waitingOf(item.row)} unread={unreadOf(item.row, arrangement.save.read)} />} />
          ))}
      />
      </View>
      <Animated.View pointerEvents="none" style={[styles.line, line]} />
      <Animated.View pointerEvents="none" style={[styles.ghost, ghost]}>
        {dragRow?.kind === 'bot' ? <BotAvatar color={dragRow.bot.color} shape={dragRow.bot.shape} size={64} />
          : dragRow ? <View style={styles.ghostGroup}><Text style={styles.ghostGlyph}>群</Text></View> : null}
      </Animated.View>
      {menuRow && (Platform.OS !== 'ios' || !NATIVE_ROW_MENU) ? (
        <HomeMenuSheet name={rowName(menuRow)} actions={chatMenu({ kind: menuRow.kind, pinned: Boolean(menuRow.kind === 'bot' && menuRow.bot.pinned), unread: unreadOf(menuRow, arrangement.save.read) })}
          onAction={action => void runAction(menuRow, action)} onClose={() => setMenuId(null)} />
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  list: { flex: 1 },
  update: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'center', height: 36, paddingHorizontal: 16, borderRadius: 18, backgroundColor: colors.bubble, marginTop: 4 },
  updateText: { fontSize: 15, color: colors.accent, fontWeight: '600' },
  pins: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 8, paddingTop: 12, paddingBottom: 8, rowGap: 16 },
  pinFace: { alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  star: { position: 'absolute', right: -2, bottom: -2, width: 22, height: 22, borderRadius: 11, backgroundColor: colors.orange, borderWidth: 2, borderColor: colors.page, alignItems: 'center', justifyContent: 'center' },
  starText: { color: colors.onAccent, fontSize: 10 },
  pinName: { fontSize: 12.5, lineHeight: 16, textAlign: 'center' },
  center: { paddingTop: 40, alignItems: 'center' },
  none: { paddingTop: 40, textAlign: 'center', fontSize: 15, color: colors.secondary },
  line: { position: 'absolute', left: 20, right: 20, top: 0, height: 2, borderRadius: 1, backgroundColor: colors.accent },
  ghost: { position: 'absolute', left: 0, top: 0 },
  ghostGroup: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.bubble, alignItems: 'center', justifyContent: 'center' },
  ghostGlyph: { fontSize: 18, color: colors.secondary },
})
