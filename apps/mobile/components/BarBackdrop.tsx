import { useCallback, useEffect, useState } from 'react'
import { Platform, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import Reanimated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'
import { ChatGlass } from '@/features/chat/components/chat-glass-capsule'
import { useReducedMotionPreference } from '@/lib/reduced-motion'
import { colors } from '@/lib/theme'
import { scrolledUnderBar } from './nav-bar-options'

/** The iOS bar's own height under the status bar. */
const BAR = 44
/** The short fade under the backdrop, so text never meets the bar's edge. */
const TAIL = 18

/**
 * Whether content has scrolled under the iOS bar, from a scroll view's onScroll (Alex 2026-11-08: on a task's
 * conversation the title, back button and messages overlapped). With the bar floating over the content, the content
 * starts at minus the bar's height; past that it is under the bar. If iOS reports the offset from zero instead, it
 * reads as scrolled at once, so the backdrop shows rather than letting text collide.
 */
export function useScrolledUnderBar() {
  const insets = useSafeAreaInsets()
  const [scrolled, setScrolled] = useState(false)
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const under = scrolledUnderBar(event.nativeEvent.contentOffset.y, insets.top + BAR)
    setScrolled(current => current === under ? current : under)
  }, [insets.top])
  return { scrolled, onScroll }
}

/**
 * The material behind the iOS bar once content scrolls under it: the system's Liquid Glass on iOS 26 (ChatGlass, which
 * turns its glass on and off with the system's own animation), the page colour under Reduce Transparency or before 26,
 * then a short fade so the words below dissolve rather than meet the bar. Drawn under the bar's own items, which stay
 * the system's (the back pill, the title, the buttons). The web build's bar takes its own space, so it draws nothing.
 */
export function BarBackdrop({ visible }: { visible: boolean }) {
  const insets = useSafeAreaInsets()
  const reduceMotion = useReducedMotionPreference()
  const shown = useSharedValue(visible ? 1 : 0)
  useEffect(() => { shown.set(reduceMotion ? (visible ? 1 : 0) : withTiming(visible ? 1 : 0, { duration: 180 })) }, [reduceMotion, shown, visible])
  const tail = useAnimatedStyle(() => ({ opacity: shown.get() }))
  if (Platform.OS !== 'ios') return null
  const height = insets.top + BAR
  return (
    <View pointerEvents="none" style={[styles.wrap, { height: height + TAIL }]}>
      <ChatGlass hidden={!visible} style={[styles.glass, { height }]}><View /></ChatGlass>
      <Reanimated.View style={[styles.tail, { top: height }, tail]}>
        <Svg width="100%" height={TAIL}>
          <Defs>
            <LinearGradient id="barTail" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={colors.page} stopOpacity={0.7} />
              <Stop offset="1" stopColor={colors.page} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Rect x="0" y="0" width="100%" height={TAIL} fill="url(#barTail)" />
        </Svg>
      </Reanimated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10 },
  // Square, full width; the solid fallback takes the page colour rather than a lifted card.
  glass: { position: 'absolute', top: 0, left: 0, right: 0, borderRadius: 0, backgroundColor: colors.page, shadowOpacity: 0, elevation: 0 },
  tail: { position: 'absolute', left: 0, right: 0, height: TAIL },
})
