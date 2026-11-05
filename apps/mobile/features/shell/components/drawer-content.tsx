import { memo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { ArrowUpDown, Check, ChevronDown, ChevronUp, GripVertical, Inbox, ListChecks, MessageCircle, Puzzle, Settings } from 'lucide-react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Reanimated, { useAnimatedStyle, useSharedValue, withSpring, type SharedValue } from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'
import type { Href } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { MyAvatar } from '@/components/AccountButton'
import { Spinner } from '@/components/icons'
import { Symbol, type SymbolName } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { Group } from '@/components/ui'
import { api, saveWorkspace } from '@/lib/api'
import { useHome } from '@/lib/home'
import type { Settings as SettingsData, Workspace } from '@/lib/types'
import { switchWorkspace } from '@/lib/workspace-switch'
import { tap } from '@/lib/haptics'
import { SNAP_BACK } from '@/lib/springs'
import { colors } from '@/lib/theme'
import { dragSlot, moveTo, orderWorkspaces } from '../model/workspace-order'
import { useWorkspaceOrder } from '../model/use-workspace-order'
import { useAppDrawer } from './app-drawer'

type Place = { href: Href; label: string; symbol: SymbolName; web: typeof Inbox; count?: number }

/**
 * What the drawer holds: the workspaces (tap to switch, 排序 to arrange them), the places reached from the drawer,
 * and the person with 设置 at the foot. Counts are live values: they draw only once the drawer is `live`, settled open.
 */
export const DrawerContent = memo(function DrawerContent({ live }: { live: boolean }) {
  const insets = useSafeAreaInsets()
  const { go, close } = useAppDrawer()
  const home = useHome()
  const data = home.data
  const [order, setOrder] = useWorkspaceOrder()
  const [listed, setListed] = useState(false)
  const [sorting, setSorting] = useState(false)
  const [switching, setSwitching] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const workspaces = orderWorkspaces(data?.workspaces ?? [], order)
  const current = data?.workspace.id
  const name = data?.workspace.name ?? ''

  const pick = async (target: Workspace) => {
    if (switching || sorting) return
    if (target.id === current) { close(); return }
    setSwitching(target.id)
    setProblem(null)
    const failed = await switchWorkspace(target, current ?? null, {
      save: saveWorkspace,
      current: async () => (await api<SettingsData>('/api/mobile/settings')).workspace.id,
    })
    await home.reload()
    setSwitching(null)
    if (failed) setProblem(failed)
    else { setListed(false); close() }
  }
  // The row being dragged while 编辑顺序 is on, and how far it has travelled.
  const drag = { from: useSharedValue(-1), travel: useSharedValue(0) }

  const places: Place[] = [
    { href: '/threads', label: '线程', symbol: 'text.bubble', web: MessageCircle, count: data?.threads.waiting },
    { href: '/tasks', label: '任务', symbol: 'checklist', web: ListChecks },
    { href: '/suggestions', label: '建议', symbol: 'tray', web: Inbox, count: data?.suggestions },
    { href: '/plugins', label: '插件', symbol: 'puzzlepiece.extension', web: Puzzle },
  ]

  return (
    <View style={[styles.drawer, { paddingTop: insets.top + 12, paddingBottom: Math.max(insets.bottom, 16) }]}>
      {/* The open workspace; a tap lists the others in place, to switch to or arrange. */}
      <View style={styles.head}>
        <Pressable accessibilityRole="button" accessibilityLabel={name} accessibilityHint={listed ? '收起工作区' : '切换工作区'} accessibilityState={{ expanded: listed }}
          onPress={() => { setListed(!listed); setSorting(false) }} style={({ pressed }) => [styles.current, pressed && styles.pressed]}>
          <View style={[styles.mark, styles.bigMark]}><Text style={styles.bigInitial}>{initial(name)}</Text></View>
          <Text style={styles.title} numberOfLines={1}>{name}</Text>
          <Symbol name={listed ? 'chevron.up' : 'chevron.down'} size={14} color={colors.secondary}
            web={listed ? <ChevronUp size={20} color={colors.secondary} strokeWidth={2.4} /> : <ChevronDown size={20} color={colors.secondary} strokeWidth={2.4} />} />
        </Pressable>
        {listed && workspaces.length > 1 ? (
          <Pressable accessibilityRole="button" accessibilityLabel={sorting ? '完成' : '编辑顺序'} hitSlop={6} onPress={() => setSorting(!sorting)} style={({ pressed }) => [styles.icon, pressed && styles.pressed]}>
            <Symbol name={sorting ? 'checkmark' : 'arrow.up.arrow.down'} size={17} color={colors.secondary}
              web={sorting ? <Check size={18} color={colors.secondary} strokeWidth={2} /> : <ArrowUpDown size={18} color={colors.secondary} strokeWidth={2} />} />
          </Pressable>
        ) : null}
      </View>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.list}>
        {listed ? workspaces.map((workspace, index) => (
          <WorkspaceRow key={workspace.id} workspace={workspace} index={index} count={workspaces.length} selected={workspace.id === current}
            busy={switching === workspace.id} disabled={Boolean(switching)} sorting={sorting} drag={drag}
            onPick={() => void pick(workspace)} onMove={(from, to) => setOrder(moveTo(workspaces.map(w => w.id), from, to))} />
        )) : null}
        {problem ? <Text accessibilityRole="alert" style={styles.problem}>{problem}</Text> : null}
        {listed ? <View style={styles.rule} /> : null}
        <Group backgroundColor={colors.drawerRow}>
          {places.map(place => (
            <Pressable key={place.label} accessibilityRole="button" accessibilityLabel={live && place.count ? `${place.label}，${place.count}` : place.label} onPress={() => go(place.href)}
              style={({ pressed }) => [styles.place, pressed && styles.pressed]}>
              <Symbol name={place.symbol} size={18} color={colors.secondary} web={<place.web size={20} color={colors.secondary} strokeWidth={1.8} />} />
              <Text style={styles.placeLabel} numberOfLines={1}>{place.label}</Text>
              {live && place.count ? <Text style={styles.count}>{place.count}</Text> : null}
            </Pressable>
          ))}
        </Group>
      </ScrollView>
      <View style={styles.foot}>
        <Pressable accessibilityRole="button" accessibilityLabel="个人资料" onPress={() => go('/settings/profile')} style={({ pressed }) => [styles.person, pressed && styles.pressed]}>
          <MyAvatar size={36} />
          <View style={styles.personText}>
            <Text style={styles.name} numberOfLines={1}>{data?.user.name || data?.user.email || ''}</Text>
            {data?.user.name ? <Text style={styles.email} numberOfLines={1}>{data.user.email}</Text> : null}
          </View>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="设置" hitSlop={4} onPress={() => go('/settings')} style={({ pressed }) => [styles.icon, styles.settings, pressed && styles.pressed]}>
          <Symbol name="gearshape" size={18} color={colors.secondary} web={<Settings size={20} color={colors.secondary} strokeWidth={1.8} />} />
        </Pressable>
      </View>
    </View>
  )
})

const ROW = 52

/**
 * A workspace in the drawer's list: a tap switches to it. While 编辑顺序 is on, its handle drags it up or down; the
 * other rows make room, and letting go puts it there.
 */
function WorkspaceRow({ workspace, index, count, selected, busy, disabled, sorting, drag, onPick, onMove }: {
  workspace: Workspace; index: number; count: number; selected: boolean; busy: boolean; disabled: boolean; sorting: boolean
  drag: { from: SharedValue<number>; travel: SharedValue<number> }; onPick: () => void; onMove: (from: number, to: number) => void
}) {
  const pan = Gesture.Pan().enabled(sorting).activeOffsetY([-4, 4])
    .onStart(() => { drag.from.set(index); drag.travel.set(0); scheduleOnRN(tap) })
    .onUpdate(event => { drag.travel.set(event.translationY) })
    .onEnd(() => {
      const to = dragSlot(index, drag.travel.get(), ROW, count)
      if (to !== index) scheduleOnRN(onMove, index, to)
    })
    .onFinalize(() => { drag.from.set(-1); drag.travel.set(withSpring(0, SNAP_BACK)) })
  const moved = useAnimatedStyle(() => {
    const from = drag.from.get()
    if (from < 0) return { zIndex: 0, transform: [{ translateY: 0 }] }
    if (from === index) return { zIndex: 1, transform: [{ translateY: drag.travel.get() }] }
    const to = dragSlot(from, drag.travel.get(), ROW, count)
    const shift = from < index && to >= index ? -ROW : from > index && to <= index ? ROW : 0
    return { zIndex: 0, transform: [{ translateY: withSpring(shift, SNAP_BACK) }] }
  })
  return (
    <Reanimated.View style={[styles.workspace, selected && styles.selected, moved]}>
      <Pressable accessibilityRole="button" accessibilityState={{ selected, busy, disabled: sorting }} accessibilityLabel={workspace.name}
        disabled={disabled || sorting} onPress={onPick} style={({ pressed }) => [styles.pick, pressed && styles.pressed]}>
        <View style={styles.mark}><Text style={styles.initial}>{initial(workspace.name)}</Text></View>
        <Text style={styles.workspaceName} numberOfLines={1}>{workspace.name}</Text>
        {sorting ? null : busy ? <Spinner size={16} />
          : selected ? <Symbol name="checkmark" size={15} color={colors.accent} web={<Check size={18} color={colors.accent} strokeWidth={2.2} />} /> : null}
      </Pressable>
      {sorting ? (
        <GestureDetector gesture={pan}>
          <View accessibilityLabel={`拖动 ${workspace.name}`} style={styles.icon}>
            <Symbol name="line.3.horizontal" size={15} color={colors.secondary} web={<GripVertical size={18} color={colors.secondary} strokeWidth={2} />} />
          </View>
        </GestureDetector>
      ) : null}
    </Reanimated.View>
  )
}

const initial = (name: string) => [...name.trim()][0]?.toUpperCase() ?? '·'

const styles = StyleSheet.create({
  drawer: { flex: 1, paddingHorizontal: 16 },
  head: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  current: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 4, borderRadius: 12, borderCurve: 'continuous' },
  title: { flexShrink: 1, fontSize: 22, lineHeight: 28, fontWeight: '700', letterSpacing: -0.4, color: colors.text },
  scroll: { flex: 1 },
  list: { paddingBottom: 8 },
  workspace: { height: ROW, flexDirection: 'row', alignItems: 'center', paddingRight: 4, borderRadius: 12, borderCurve: 'continuous' },
  pick: { flex: 1, minWidth: 0, alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12 },
  selected: { backgroundColor: colors.chip },
  pressed: { backgroundColor: colors.pressed },
  mark: { width: 32, height: 32, borderRadius: 8, borderCurve: 'continuous', backgroundColor: colors.drawerRow, alignItems: 'center', justifyContent: 'center' },
  // The workspace's first character, in ink: a grey 个 reads as an arrow.
  initial: { fontSize: 16, fontWeight: '600', color: colors.ink },
  bigMark: { width: 36, height: 36, borderRadius: 10 },
  bigInitial: { fontSize: 17, fontWeight: '600', color: colors.ink },
  workspaceName: { flex: 1, minWidth: 0, fontSize: 16, lineHeight: 21, fontWeight: '500', color: colors.text },
  problem: { fontSize: 13, color: colors.danger, paddingHorizontal: 12, paddingTop: 6 },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: colors.separator, marginTop: 4, marginBottom: 12 },
  place: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16 },
  placeLabel: { flex: 1, minWidth: 0, fontSize: 16, lineHeight: 21, color: colors.text },
  count: { fontSize: 16, lineHeight: 21, color: colors.secondary, fontVariant: ['tabular-nums'] },
  foot: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 4 },
  person: { flex: 1, minWidth: 0, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, borderCurve: 'continuous' },
  personText: { flex: 1, minWidth: 0 },
  name: { fontSize: 16, lineHeight: 21, fontWeight: '600', color: colors.text },
  email: { fontSize: 13, lineHeight: 18, color: colors.secondary },
  icon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  settings: { backgroundColor: colors.drawerRow },
})
