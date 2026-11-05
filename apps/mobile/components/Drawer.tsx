import { createContext, type ComponentRef, type ReactNode, type RefObject, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AccessibilityInfo, BackHandler, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { cancelAnimation, interpolate, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { usePathname, useRouter, type Href } from 'expo-router'
import { CircleArrowDown, Inbox, ListChecks, Puzzle, Settings, X } from 'lucide-react-native'
import { Text } from '@/components/Text'
import { Avatar as UserAvatar } from '@/components/settings'
import { Symbol } from '@/components/Symbol'
import { tap } from '@/lib/haptics'
import { useHome } from '@/lib/home'
import { restartToUpdate, useUpdateReady } from '@/lib/updates'
import { colors } from '@/lib/theme'
import { useReducedMotionPreference } from '@/lib/reduced-motion'

type DrawerState = { open: () => void; close: () => void; isOpen: boolean }
type NativeView = ComponentRef<typeof View>
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
  const router = useRouter()
  const [isOpen, setOpen] = useState(false)
  const reduceMotion = useReducedMotionPreference()
  const panelRef = useRef<NativeView>(null)
  const contentRef = useRef<NativeView>(null)
  const closeRef = useRef<NativeView>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  // 0 closed … 1 open.
  const progress = useSharedValue(0)
  const start = useSharedValue(0)
  const dragging = useSharedValue(false)

  const settle = useCallback((open: boolean, velocity = 0) => {
    'worklet'
    progress.value = reduceMotion ? (open ? 1 : 0) : withSpring(open ? 1 : 0, { ...SPRING, velocity: velocity / panel })
  }, [panel, progress, reduceMotion])

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

  // A destination owns its navigation transition; don't run a second, closing
  // drawer spring underneath it or leave the old screen displaced on return.
  const navigate = useCallback((href: Href) => {
    returnFocus.current = null
    cancelAnimation(progress)
    progress.value = 0
    changed(false)
    router.push(href)
  }, [changed, progress, router])

  useEffect(() => {
    if (reduceMotion && !dragging.value) {
      cancelAnimation(progress)
      progress.value = isOpen ? 1 : 0
    }
  }, [dragging, isOpen, progress, reduceMotion])

  useEffect(() => {
    if (!isOpen || Platform.OS === 'web') return
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { value.close(); return true })
    if (closeRef.current) AccessibilityInfo.sendAccessibilityEvent(closeRef.current, 'focus')
    return () => subscription.remove()
  }, [isOpen, value])

  // pointerEvents only affects touches. Hidden drawer controls must also leave
  // keyboard navigation, and an open drawer must keep focus out of the page.
  useLayoutEffect(() => {
    if (Platform.OS !== 'web') return
    const panelNode = panelRef.current as unknown as HTMLElement | null
    const contentNode = contentRef.current as unknown as HTMLElement | null
    if (!panelNode || !contentNode) return
    if (isOpen && document.activeElement instanceof HTMLElement && !panelNode.contains(document.activeElement)) {
      returnFocus.current = document.activeElement
    }
    panelNode.inert = !isOpen
    contentNode.inert = isOpen
    if (!isOpen) {
      if (returnFocus.current?.isConnected) returnFocus.current.focus()
      returnFocus.current = null
      return
    }
    const focusable = () => Array.from(panelNode.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
      .filter(node => !node.hasAttribute('disabled') && node.getClientRects().length > 0)
    focusable()[0]?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); value.close(); return }
      if (event.key !== 'Tab') return
      const nodes = focusable()
      const first = nodes[0]
      const last = nodes.at(-1)
      if (!first || !last) return
      if (event.shiftKey && (document.activeElement === first || !panelNode.contains(document.activeElement))) {
        event.preventDefault(); last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !panelNode.contains(document.activeElement))) {
        event.preventDefault(); first.focus()
      }
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [isOpen, value])

  const pan = Gesture.Pan()
    .enabled(isOpen || drawerRoot(path))
    // Closed: only a rightward swipe takes over, so vertical scrolling stays the list's.
    .activeOffsetX(isOpen ? [-12, 12] : [-10000, 14])
    .failOffsetY([-14, 14])
    .onStart(() => { cancelAnimation(progress); start.value = progress.value; dragging.value = true })
    .onUpdate(event => {
      progress.value = Math.min(1, Math.max(0, start.value + event.translationX / panel))
    })
    .onEnd((event, success) => {
      if (!success) return
      const open = event.velocityX > 500 ? true : event.velocityX < -500 ? false : progress.value > 0.5
      settle(open, event.velocityX)
      scheduleOnRN(changed, open)
    })
    .onFinalize((_event, success) => {
      if (!success && dragging.value) settle(isOpen)
      dragging.value = false
    })

  const contentStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.value * panel }],
    borderTopLeftRadius: interpolate(progress.value, [0, 0.15], [0, 28], 'clamp'),
    borderBottomLeftRadius: interpolate(progress.value, [0, 0.15], [0, 28], 'clamp'),
    shadowOpacity: progress.value * 0.12,
  }))
  const dimStyle = useAnimatedStyle(() => ({ opacity: progress.value * 0.12 }))
  const panelStyle = useAnimatedStyle(() => ({ transform: [{ translateX: reduceMotion ? 0 : (progress.value - 1) * panel * 0.3 }] }))

  return (
    <DrawerContext.Provider value={value}>
      <GestureDetector gesture={pan}>
        <View style={styles.root}>
          <Animated.View ref={panelRef} style={[styles.panel, { width: panel }, panelStyle]} pointerEvents={isOpen ? 'auto' : 'none'}
            accessibilityElementsHidden={!isOpen} importantForAccessibility={isOpen ? 'auto' : 'no-hide-descendants'} aria-hidden={!isOpen}
            accessibilityViewIsModal={isOpen} onAccessibilityEscape={value.close}>
            <DrawerPanel onNavigate={navigate} onClose={value.close} closeRef={closeRef} />
          </Animated.View>
          <Animated.View style={[styles.content, contentStyle]}>
            <View ref={contentRef} style={{ flex: 1 }} accessibilityElementsHidden={isOpen} importantForAccessibility={isOpen ? 'no-hide-descendants' : 'auto'} aria-hidden={isOpen}>
              {children}
            </View>
            <Animated.View pointerEvents="none" style={[styles.dim, dimStyle]} />
            {isOpen ? <Pressable accessibilityRole="button" accessibilityLabel="关闭菜单" style={StyleSheet.absoluteFill} onPress={value.close} /> : null}
          </Animated.View>
        </View>
      </GestureDetector>
    </DrawerContext.Provider>
  )
}

/** The person's photo, or their initials on a colour. */
export function Avatar({ size = 32 }: { size?: number }) {
  const user = useHome().data?.user
  return <UserAvatar name={user?.name || user?.email || ''} image={user?.image ?? null} size={size} />
}

function DrawerPanel({ onNavigate, onClose, closeRef }: { onNavigate: (href: Href) => void; onClose: () => void; closeRef: RefObject<NativeView | null> }) {
  const insets = useSafeAreaInsets()
  const { data } = useHome()
  const updateReady = useUpdateReady()
  const go = onNavigate
  return (
    <View style={{ flex: 1, paddingTop: insets.top + 12, paddingBottom: Math.max(insets.bottom, 8) }}>
      <View style={styles.header}>
      <Pressable accessibilityRole="button" accessibilityLabel="设置" onPress={() => go('/settings')} style={({ pressed }) => [styles.me, pressed && styles.rowActive]}>
        <Avatar size={44} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.meName} numberOfLines={1}>{data?.user.name || data?.user.email || ''}</Text>
          {data ? <Text style={styles.meDetail} numberOfLines={1}>{data.workspace.name}</Text> : null}
        </View>
      </Pressable>
      <Pressable ref={closeRef} accessibilityRole="button" accessibilityLabel="关闭菜单" onPress={onClose} style={({ pressed }) => [styles.close, pressed && styles.rowActive]}>
        <Symbol name="xmark" size={20} color={colors.secondary} web={<X size={20} color={colors.secondary} />} />
      </Pressable>
      </View>
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
  rowActive: { backgroundColor: colors.pressed },
  rowIcon: { width: 26, alignItems: 'center' },
  rowLabel: { flex: 1, fontSize: 17 },
  count: { fontSize: 15, color: colors.secondary },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 14 },
  me: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 14 },
  meName: { fontSize: 17, fontWeight: '600' },
  meDetail: { fontSize: 14, color: colors.secondary, marginTop: 2 },
  // The pushed screen dims as the drawer opens, as iOS dims what a panel covers.
  dim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#000' },
})
