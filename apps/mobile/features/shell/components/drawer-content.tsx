import { memo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { ArrowUpDown, Check, ChevronDown, ChevronUp, Inbox, ListChecks, MessageCircle, Puzzle, Settings } from 'lucide-react-native'
import type { Href } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { MyAvatar } from '@/components/AccountButton'
import { Spinner } from '@/components/icons'
import { Symbol, type SymbolName } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { api, saveWorkspace } from '@/lib/api'
import { useHome } from '@/lib/home'
import type { Settings as SettingsData, Workspace } from '@/lib/types'
import { switchWorkspace } from '@/lib/workspace-switch'
import { colors } from '@/lib/theme'
import { moveWorkspace, orderWorkspaces } from '../model/workspace-order'
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
  const move = (id: string, step: -1 | 1) => setOrder(moveWorkspace(workspaces.map(w => w.id), id, step))

  const places: Place[] = [
    { href: '/threads', label: '线程', symbol: 'text.bubble', web: MessageCircle, count: data?.threads.waiting },
    { href: '/tasks', label: '任务', symbol: 'checklist', web: ListChecks },
    { href: '/suggestions', label: '建议', symbol: 'tray', web: Inbox, count: data?.suggestions },
    { href: '/plugins', label: '插件', symbol: 'puzzlepiece.extension', web: Puzzle },
  ]

  return (
    <View style={[styles.drawer, { paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, 12) }]}>
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
          <Pressable accessibilityRole="button" accessibilityLabel={sorting ? '完成排序' : '排序'} hitSlop={6} onPress={() => setSorting(!sorting)} style={({ pressed }) => [styles.icon, pressed && styles.pressed]}>
            <Symbol name={sorting ? 'checkmark' : 'arrow.up.arrow.down'} size={17} color={colors.secondary}
              web={sorting ? <Check size={18} color={colors.secondary} strokeWidth={2} /> : <ArrowUpDown size={18} color={colors.secondary} strokeWidth={2} />} />
          </Pressable>
        ) : null}
      </View>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.list}>
        {listed ? workspaces.map((workspace, index) => {
          const selected = workspace.id === current
          return (
            <View key={workspace.id} style={[styles.workspace, selected && styles.selected]}>
              {/* While arranging, the row is not a switch: only its arrows act. */}
              <Pressable accessibilityRole="button" accessibilityState={{ selected, busy: switching === workspace.id, disabled: sorting }} accessibilityLabel={workspace.name}
                disabled={Boolean(switching) || sorting} onPress={() => void pick(workspace)}
                style={({ pressed }) => [styles.pick, pressed && styles.pressed]}>
                <View style={styles.mark}><Text style={styles.initial}>{initial(workspace.name)}</Text></View>
                <Text style={styles.workspaceName} numberOfLines={1}>{workspace.name}</Text>
                {sorting ? null : switching === workspace.id ? <Spinner size={16} />
                  : selected ? <Symbol name="checkmark" size={15} color={colors.accent} web={<Check size={18} color={colors.accent} strokeWidth={2.2} />} /> : null}
              </Pressable>
              {sorting ? (
                <View style={styles.moves}>
                  <Pressable accessibilityRole="button" accessibilityLabel={`上移 ${workspace.name}`} disabled={index === 0} hitSlop={6} onPress={() => move(workspace.id, -1)} style={[styles.icon, index === 0 && styles.off]}>
                    <Symbol name="chevron.up" size={15} color={colors.secondary} web={<ChevronUp size={18} color={colors.secondary} strokeWidth={2} />} />
                  </Pressable>
                  <Pressable accessibilityRole="button" accessibilityLabel={`下移 ${workspace.name}`} disabled={index === workspaces.length - 1} hitSlop={6} onPress={() => move(workspace.id, 1)} style={[styles.icon, index === workspaces.length - 1 && styles.off]}>
                    <Symbol name="chevron.down" size={15} color={colors.secondary} web={<ChevronDown size={18} color={colors.secondary} strokeWidth={2} />} />
                  </Pressable>
                </View>
              ) : null}
            </View>
          )
        }) : null}
        {problem ? <Text accessibilityRole="alert" style={styles.problem}>{problem}</Text> : null}
        {listed ? <View style={styles.rule} /> : null}
        {places.map(place => (
          <Pressable key={place.label} accessibilityRole="button" accessibilityLabel={live && place.count ? `${place.label}，${place.count}` : place.label} onPress={() => go(place.href)}
            style={({ pressed }) => [styles.place, pressed && styles.pressed]}>
            <Symbol name={place.symbol} size={18} color={colors.secondary} web={<place.web size={20} color={colors.secondary} strokeWidth={1.8} />} />
            <Text style={styles.placeLabel} numberOfLines={1}>{place.label}</Text>
            {live && place.count ? <Text style={styles.count}>{place.count}</Text> : null}
          </Pressable>
        ))}
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

const initial = (name: string) => [...name.trim()][0]?.toUpperCase() ?? '·'

const styles = StyleSheet.create({
  drawer: { flex: 1, paddingLeft: 18, paddingRight: 12 },
  head: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 6, marginBottom: 6 },
  current: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, paddingHorizontal: 4, borderRadius: 16 },
  title: { flexShrink: 1, fontSize: 26, lineHeight: 32, fontWeight: '700', letterSpacing: -0.5 },
  scroll: { flex: 1 },
  list: { paddingBottom: 12 },
  workspace: { height: 52, flexDirection: 'row', alignItems: 'center', paddingRight: 6, borderRadius: 16, borderCurve: 'continuous' },
  pick: { flex: 1, minWidth: 0, alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 10 },
  selected: { backgroundColor: colors.surface },
  pressed: { opacity: 0.58 },
  mark: { width: 36, height: 36, borderRadius: 10, borderCurve: 'continuous', backgroundColor: colors.bubble, alignItems: 'center', justifyContent: 'center' },
  initial: { fontSize: 16, fontWeight: '600', color: colors.secondary },
  bigMark: { width: 44, height: 44, borderRadius: 12 },
  bigInitial: { fontSize: 20, fontWeight: '600', color: colors.secondary },
  workspaceName: { flex: 1, minWidth: 0, fontSize: 16, lineHeight: 21, fontWeight: '500' },
  moves: { flexDirection: 'row', gap: 2 },
  off: { opacity: 0.3 },
  problem: { fontSize: 13, color: colors.danger, paddingHorizontal: 10, paddingTop: 6 },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: colors.separator, marginHorizontal: 10, marginTop: 10, marginBottom: 6 },
  place: { height: 46, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, borderRadius: 16, borderCurve: 'continuous' },
  placeLabel: { flex: 1, minWidth: 0, fontSize: 16, lineHeight: 21 },
  count: { fontSize: 14, color: colors.secondary, fontVariant: ['tabular-nums'] },
  foot: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 8 },
  person: { flex: 1, minWidth: 0, minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, borderRadius: 16 },
  personText: { flex: 1, minWidth: 0 },
  name: { fontSize: 14, lineHeight: 19, fontWeight: '600' },
  email: { fontSize: 12.5, lineHeight: 16, color: colors.secondary },
  icon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  settings: { backgroundColor: colors.surface },
})
