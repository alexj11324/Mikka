import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react'
import { Image, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { interpolate, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { usePathname, useRouter, type Href } from 'expo-router'
import { CircleArrowDown, Inbox, ListChecks, Puzzle, Settings } from 'lucide-react-native'
import { Text } from '@/components/Text'
import { Symbol } from '@/components/Symbol'
import { tap } from '@/lib/haptics'
import { useHome } from '@/lib/home'
import { restartToUpdate, useUpdateReady } from '@/lib/updates'
import { colors } from '@/lib/theme'

type DrawerState = { open: () => void; close: () => void; isOpen: boolean }
const DrawerContext = createContext<DrawerState>({ open: () => {}, close: () => {}, isOpen: false })
export const useDrawer = () => useContext(DrawerContext)

// Close to UIKit's default spring: settles fast, no visible bounce.
const SPRING = { damping: 30, stiffness: 300, mass: 0.9, overshootClamping: true }

/** The tab roots: a chat or thread pushed over them keeps the system's swipe back instead. */
const drawerRoot = (path: string) => path === '/chats' || path === '/threads' || path === '/search'

/**
 * The side drawer, opened from the person's avatar at the top left of 对话 (as
 * in Grok and the ChatGPT app) or by swiping right on a tab's root: it slides
 * in from the left and pushes the tabs right, following the finger, and
 * settles by position and speed on the UI thread. It holds the person, 建议,
 * 任务, 插件 and 设置; the bots are on 对话 itself.
 */
export function DrawerHost({ children }: { children: ReactNode }) {
  const { width } = useWindowDimensions()
  const panel = Math.min(width * 0.82, 340)
  const path = usePathname()
  const [isOpen, setOpen] = useState(false)
  // 0 closed … 1 open.
  const progress = useSharedValue(0)
  const start = useSharedValue(0)

  const settle = useCallback((open: boolean, velocity = 0) => {
    'worklet'
    progress.value = withSpring(open ? 1 : 0, { ...SPRING, velocity: velocity / panel })
  }, [panel, progress])

  const changed = useCallback((open: boolean) => {
    setOpen(was => {
      if (was !== open) tap()
      return open
    })
  }, [])

  const value = useMemo(() => ({
    open: () => { settle(true); changed(true) },
    close: () => { settle(false); changed(false) },
    isOpen,
  }), [changed, isOpen, settle])

  const pan = Gesture.Pan()
    .enabled(isOpen || drawerRoot(path))
    // Closed: only a rightward swipe takes over, so vertical scrolling stays the list's.
    .activeOffsetX(isOpen ? [-12, 12] : [-10000, 14])
    .failOffsetY([-14, 14])
    .onBegin(() => { start.value = progress.value })
    .onUpdate(event => {
      progress.value = Math.min(1, Math.max(0, start.value + event.translationX / panel))
    })
    .onEnd(event => {
      const open = event.velocityX > 500 ? true : event.velocityX < -500 ? false : progress.value > 0.5
      settle(open, event.velocityX)
      scheduleOnRN(changed, open)
    })

  const contentStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.value * panel }],
    borderTopLeftRadius: interpolate(progress.value, [0, 0.15], [0, 28], 'clamp'),
    borderBottomLeftRadius: interpolate(progress.value, [0, 0.15], [0, 28], 'clamp'),
    shadowOpacity: progress.value * 0.12,
  }))
  const dimStyle = useAnimatedStyle(() => ({ opacity: progress.value * 0.12 }))
  const panelStyle = useAnimatedStyle(() => ({ transform: [{ translateX: (progress.value - 1) * panel * 0.3 }] }))

  return (
    <DrawerContext.Provider value={value}>
      <GestureDetector gesture={pan}>
        <View style={styles.root}>
          <Animated.View style={[styles.panel, { width: panel }, panelStyle]} pointerEvents={isOpen ? 'auto' : 'none'}>
            <DrawerPanel onNavigate={value.close} />
          </Animated.View>
          <Animated.View style={[styles.content, contentStyle]}>
            {children}
            <Animated.View pointerEvents="none" style={[styles.dim, dimStyle]} />
            {isOpen ? <Pressable accessibilityLabel="关闭菜单" style={StyleSheet.absoluteFill} onPress={value.close} /> : null}
          </Animated.View>
        </View>
      </GestureDetector>
    </DrawerContext.Provider>
  )
}

/** The person's photo, or their initials on a colour. */
export function Avatar({ size = 32 }: { size?: number }) {
  const user = useHome().data?.user
  const round = { width: size, height: size, borderRadius: size / 2 }
  if (user?.image) return <Image source={{ uri: user.image }} style={round} accessibilityIgnoresInvertColors />
  const initials = (user?.name || user?.email || '').trim().slice(0, 2).toUpperCase()
  return <View style={[round, styles.initials]}><Text style={[styles.initialsText, { fontSize: size * 0.4 }]}>{initials}</Text></View>
}

function DrawerPanel({ onNavigate }: { onNavigate: () => void }) {
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const { data } = useHome()
  const updateReady = useUpdateReady()
  const go = (href: Href) => { onNavigate(); router.push(href) }
  return (
    <View style={{ flex: 1, paddingTop: insets.top + 12, paddingBottom: Math.max(insets.bottom, 8) }}>
      <Pressable accessibilityRole="button" accessibilityLabel="设置" onPress={() => go('/settings')} style={({ pressed }) => [styles.me, pressed && styles.rowActive]}>
        <Avatar size={44} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.meName} numberOfLines={1}>{data?.user.name || data?.user.email || ''}</Text>
          {data ? <Text style={styles.meDetail} numberOfLines={1}>{data.workspace.name}</Text> : null}
        </View>
      </Pressable>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 8, paddingTop: 12, paddingBottom: 16 }}>
        <Row onPress={() => go('/suggestions')} icon={<Symbol name="tray" web={<Inbox size={22} color={colors.ink} strokeWidth={1.8} />} />} label="建议"
          trailing={data?.suggestions ? <Text style={styles.count}>{data.suggestions}</Text> : null} />
        <Row onPress={() => go('/tasks')} icon={<Symbol name="checklist" web={<ListChecks size={22} color={colors.ink} strokeWidth={1.8} />} />} label="任务" />
        <Row onPress={() => go('/plugins')} icon={<Symbol name="puzzlepiece.extension" web={<Puzzle size={22} color={colors.ink} strokeWidth={1.8} />} />} label="插件" />
        <Row onPress={() => go('/settings')} icon={<Symbol name="gearshape" web={<Settings size={22} color={colors.ink} strokeWidth={1.8} />} />} label="设置" />
        {updateReady ? <Row onPress={restartToUpdate} icon={<Symbol name="arrow.down.circle" color={colors.accent} web={<CircleArrowDown size={22} color={colors.accent} strokeWidth={1.8} />} />} label="重启以更新" /> : null}
      </ScrollView>
    </View>
  )
}

function Row({ icon, label, trailing, onPress }: { icon: ReactNode; label: string; trailing?: ReactNode; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.rowActive]}>
      <View style={styles.rowIcon}>{icon}</View>
      <Text style={styles.rowLabel} numberOfLines={1}>{label}</Text>
      {trailing}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.grouped, overflow: 'hidden' },
  panel: { position: 'absolute', top: 0, bottom: 0, left: 0, backgroundColor: colors.grouped },
  content: { flex: 1, backgroundColor: colors.page, overflow: 'hidden', shadowColor: '#000', shadowRadius: 16, shadowOffset: { width: -2, height: 0 } },
  row: { flexDirection: 'row', alignItems: 'center', height: 50, paddingHorizontal: 12, borderRadius: 14, gap: 14 },
  rowActive: { backgroundColor: '#E4E4E6' },
  rowIcon: { width: 26, alignItems: 'center' },
  rowLabel: { flex: 1, fontSize: 17 },
  count: { fontSize: 15, color: colors.secondary },
  me: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 14 },
  meName: { fontSize: 17, fontWeight: '600' },
  meDetail: { fontSize: 14, color: colors.secondary, marginTop: 2 },
  initials: { backgroundColor: '#3D7A5C', alignItems: 'center', justifyContent: 'center' },
  initialsText: { color: '#fff', fontWeight: '600' },
  // The pushed screen dims as the drawer opens, as iOS dims what a panel covers.
  dim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#000' },
})
