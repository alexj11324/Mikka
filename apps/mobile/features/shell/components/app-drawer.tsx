import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native'
import { type Href, usePathname, useRouter } from 'expo-router'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Reanimated, { Extrapolation, interpolate, ReduceMotion, useAnimatedReaction, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { scheduleOnRN } from 'react-native-worklets'
import { tap } from '@/lib/haptics'
import { colors, drawerLift } from '@/lib/theme'
import { CLOSE_PAN, DRAWER_SPRING, dragProgress, drawerWidth, OPEN_PAN, ROUNDED_AT, settlesOpen, surfaceDim, surfaceRadius, surfaceScale } from '../model/drawer'
import { DrawerContent } from './drawer-content'

type AppDrawerValue = {
  open: () => void
  close: () => void
  /** Closes the drawer, then pushes `href` once the app is back in place. */
  go: (href: Href) => void
  /** While a home-list drag holds the screen, a trailing swipe must not open the drawer. */
  hold: (blocked: boolean) => void
}

const AppDrawerContext = createContext<AppDrawerValue | null>(null)

const SPRING = { ...DRAWER_SPRING, reduceMotion: ReduceMotion.System }

/**
 * The app's frame (#1408 Phase 2): one Stack on a surface that slides right to show the drawer lying under it. On
 * the home screen a drag to the right pulls the surface open; the header's workspace button opens it too. While open,
 * the surface rounds to the screen's corners, lifts with a soft shadow and takes a light veil; a tap on it or a drag back closes the drawer.
 */
export function AppDrawer({ children }: { children: ReactNode }) {
  const router = useRouter()
  const home = usePathname() === '/'
  const { width: screen } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const width = drawerWidth(screen)
  const radius = surfaceRadius(insets)
  const lift = drawerLift.shadowOpacity
  const progress = useSharedValue(0)
  const blockOpen = useSharedValue(false)
  // The same as `shown`, on the UI thread: the drags read it as they start, so a render never rebuilds them mid-drag.
  const shownOnUI = useSharedValue(false)
  // Open from the moment it starts to open until it has closed: VoiceOver reads the drawer, not the app, meanwhile.
  const [shown, setShown] = useState(false)
  // Settled open: only then does the drawer draw its live values, so a render never lands mid-motion.
  const [settled, setSettled] = useState(false)
  const pending = useRef<Href | null>(null)

  const opened = useCallback(() => setSettled(true), [])
  const closed = useCallback(() => {
    shownOnUI.set(false)
    setShown(false)
    setSettled(false)
    const href = pending.current
    pending.current = null
    if (href) router.push(href)
  }, [router, shownOnUI])
  const starting = useCallback(() => { shownOnUI.set(true); setShown(true); tap() }, [shownOnUI])
  const closing = useCallback(() => { setSettled(false); tap() }, [])

  const settle = useCallback((open: boolean, velocity = 0) => {
    'worklet'
    progress.set(withSpring(open ? 1 : 0, { ...SPRING, velocity }, finished => {
      if (finished) scheduleOnRN(open ? opened : closed)
    }))
  }, [closed, opened, progress])

  const open = useCallback(() => { starting(); settle(true) }, [settle, starting])
  const close = useCallback(() => { closing(); settle(false) }, [closing, settle])
  const go = useCallback((href: Href) => { pending.current = href; close() }, [close])
  const hold = useCallback((blocked: boolean) => { blockOpen.set(blocked) }, [blockOpen])

  // Only the home screen opens the drawer by a drag: elsewhere a drag to the right is the system's back swipe.
  const openPan = useMemo(() => Gesture.Pan()
    .enabled(home)
    .onTouchesDown((_event, manager) => { if (shownOnUI.get() || blockOpen.get()) manager.fail() })
    .activeOffsetX(OPEN_PAN.activeX)
    .failOffsetX(OPEN_PAN.failX)
    .failOffsetY([-OPEN_PAN.failY, OPEN_PAN.failY])
    .onStart(() => { shownOnUI.set(true); scheduleOnRN(setShown, true) })
    .onUpdate(event => { progress.set(dragProgress(0, event.translationX, width)) })
    .onEnd(event => {
      const velocity = event.velocityX / width
      const open = settlesOpen(progress.get(), velocity)
      if (open) scheduleOnRN(tap)
      settle(open, velocity)
    }), [blockOpen, home, progress, settle, shownOnUI, width])
  const closePan = useMemo(() => Gesture.Pan()
    .onTouchesDown((_event, manager) => { if (!shownOnUI.get()) manager.fail() })
    .activeOffsetX(CLOSE_PAN.activeX)
    .failOffsetX(CLOSE_PAN.failX)
    .failOffsetY([-CLOSE_PAN.failY, CLOSE_PAN.failY])
    .onStart(() => { scheduleOnRN(setSettled, false) })
    .onUpdate(event => { progress.set(dragProgress(1, event.translationX, width)) })
    .onEnd(event => {
      const velocity = event.velocityX / width
      const open = settlesOpen(progress.get(), velocity)
      if (!open) scheduleOnRN(tap)
      settle(open, velocity)
    }), [progress, settle, shownOnUI, width])

  // A drag that ends where it began (0 or 1) has no spring to finish: settle the state here as well.
  useAnimatedReaction(() => progress.get() <= 0, (atRest, before) => {
    if (atRest && before === false) scheduleOnRN(closed)
  }, [closed])

  const surface = useAnimatedStyle(() => {
    const open = progress.get()
    return {
      borderRadius: interpolate(open, [0, ROUNDED_AT], [0, radius], Extrapolation.CLAMP),
      // Scale first, then slide by the full drawer width, so the shrink does not eat the slide.
      transform: [{ scale: surfaceScale(open) }, { translateX: open * width }],
      shadowOpacity: open * lift,
    }
  })
  const clip = useAnimatedStyle(() => ({
    borderRadius: interpolate(progress.get(), [0, ROUNDED_AT], [0, radius], Extrapolation.CLAMP),
  }))
  const drawer = useAnimatedStyle(() => ({
    opacity: interpolate(progress.get(), [0, 1], [0.5, 1]),
    transform: [{ translateX: interpolate(progress.get(), [0, 1], [-24, 0]) }],
  }))
  const dim = useAnimatedStyle(() => ({ opacity: surfaceDim(progress.get()) }))

  const value = useMemo(() => ({ open, close, go, hold }), [close, go, hold, open])
  return (
    <AppDrawerContext.Provider value={value}>
      <View style={styles.frame}>
        <Reanimated.View style={[styles.drawer, { width }, drawer]}
          accessibilityElementsHidden={!shown} importantForAccessibility={shown ? 'auto' : 'no-hide-descendants'}>
          <DrawerContent live={settled} />
        </Reanimated.View>
        <GestureDetector gesture={Gesture.Exclusive(closePan, openPan)}>
          <Reanimated.View style={[styles.surface, surface]}>
            <Reanimated.View style={[styles.clip, clip]}>
              <View style={styles.fill} pointerEvents={shown ? 'none' : 'auto'}
                accessibilityElementsHidden={shown} importantForAccessibility={shown ? 'no-hide-descendants' : 'auto'}>
                {children}
              </View>
              <Reanimated.View style={[StyleSheet.absoluteFill, styles.dim, dim]} pointerEvents="none" />
              {shown ? <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel="关闭侧栏" onPress={close} /> : null}
            </Reanimated.View>
          </Reanimated.View>
        </GestureDetector>
      </View>
    </AppDrawerContext.Provider>
  )
}

export function useAppDrawer(): AppDrawerValue {
  const value = useContext(AppDrawerContext)
  if (!value) throw new Error('useAppDrawer outside AppDrawer')
  return value
}

const styles = StyleSheet.create({
  frame: { flex: 1, backgroundColor: colors.drawer },
  drawer: { position: 'absolute', top: 0, bottom: 0, left: 0, backgroundColor: colors.drawer },
  // Shadow lives on the shell, which is not clipped, so it follows the radius. The clip hides the page's square corners.
  surface: {
    flex: 1,
    backgroundColor: colors.page,
    borderCurve: 'continuous',
    shadowColor: drawerLift.shadowColor,
    shadowOffset: drawerLift.shadowOffset,
    shadowRadius: drawerLift.shadowRadius,
    shadowOpacity: 0,
    elevation: drawerLift.elevation,
    boxShadow: drawerLift.boxShadow,
  },
  clip: { flex: 1, overflow: 'hidden', backgroundColor: colors.page, borderCurve: 'continuous' },
  fill: { flex: 1 },
  dim: { backgroundColor: colors.drawerDim },
})
