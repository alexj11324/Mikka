import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Check, GripVertical } from 'lucide-react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Reanimated, { useAnimatedStyle, useSharedValue, withSpring, type SharedValue } from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'
import { Spinner } from '@/components/icons'
import { NavBar, underBar } from '@/components/NavBar'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { tap } from '@/lib/haptics'
import { SNAP_BACK } from '@/lib/springs'
import type { Workspace } from '@/lib/types'
import { colors } from '@/lib/theme'
import { useWorkspaces } from '../model/use-workspaces'
import { dragSlot, moveTo } from '../model/workspace-order'

const ROW = 52

/**
 * 工作区 (Comma design 19): the person's workspaces in one group, a check on the open one. A tap switches to it and
 * goes back; 编辑 shows handles that drag a workspace up or down, and the order is kept on this device.
 */
export function WorkspacesScreen() {
  const router = useRouter()
  const { workspaces, current, pick, switching, problem, setOrder } = useWorkspaces()
  const [sorting, setSorting] = useState(false)
  const drag = { from: useSharedValue(-1), travel: useSharedValue(0) }
  return (
    <View style={styles.screen}>
      <NavBar title="工作区" large
        right={{ icon: 'checkmark', label: sorting ? '完成' : '编辑', text: sorting ? '完成' : '编辑', web: <Text style={styles.word}>{sorting ? '完成' : '编辑'}</Text>, onPress: () => setSorting(on => !on) }} />
      <ScrollView {...underBar} contentContainerStyle={styles.content}>
        <View style={styles.group}>
          {workspaces.map((workspace, index) => (
            <WorkspaceRow key={workspace.id} workspace={workspace} index={index} count={workspaces.length} drag={drag}
              selected={workspace.id === current?.id} busy={switching === workspace.id} disabled={Boolean(switching)} sorting={sorting}
              onPick={async () => { if (await pick(workspace)) router.back() }}
              onMove={(from, to) => setOrder(moveTo(workspaces.map(w => w.id), from, to))} />
          ))}
        </View>
        {problem ? <Text style={styles.problem}>{problem}</Text> : null}
      </ScrollView>
    </View>
  )
}

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
    <Reanimated.View style={[styles.row, moved]}>
      <Pressable accessibilityRole="button" accessibilityState={{ selected, busy, disabled: sorting }} accessibilityLabel={workspace.name}
        disabled={disabled || sorting} onPress={onPick} style={({ pressed }) => [styles.pick, pressed && { opacity: 0.6 }]}>
        <View style={styles.mark}><Text style={styles.initial}>{[...workspace.name.trim()][0]?.toUpperCase() ?? '·'}</Text></View>
        <Text style={styles.name} numberOfLines={1}>{workspace.name}</Text>
        {sorting ? null : busy ? <Spinner size={16} />
          : selected ? <Symbol name="checkmark" size={17} color={colors.ink} web={<Check size={20} color={colors.ink} strokeWidth={2.2} />} /> : null}
      </Pressable>
      {sorting ? (
        <GestureDetector gesture={pan}>
          <View accessibilityLabel={`拖动 ${workspace.name}`} style={styles.handle}>
            <Symbol name="line.3.horizontal" size={16} color={colors.secondary} web={<GripVertical size={18} color={colors.secondary} strokeWidth={2} />} />
          </View>
        </GestureDetector>
      ) : null}
    </Reanimated.View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.grouped },
  content: { padding: 16, paddingBottom: 32 },
  group: { borderRadius: 16, borderCurve: 'continuous', backgroundColor: colors.surface, paddingVertical: 4 },
  row: { height: ROW, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: 16 },
  pick: { flex: 1, minWidth: 0, height: ROW, flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16 },
  mark: { width: 28, height: 28, borderRadius: 7, borderCurve: 'continuous', backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  initial: { fontSize: 14, fontWeight: '700', color: colors.page },
  name: { flex: 1, fontSize: 17 },
  handle: { width: 44, height: ROW, alignItems: 'center', justifyContent: 'center' },
  word: { fontSize: 17, fontWeight: '600', color: colors.ink },
  problem: { marginTop: 12, paddingHorizontal: 16, fontSize: 13, color: colors.danger },
})
