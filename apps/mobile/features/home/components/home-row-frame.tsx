import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { I18nManager, Platform, Pressable, StyleSheet, View } from 'react-native'
import { Link, type Href } from 'expo-router'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withSpring, type SharedValue } from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'
import { Text } from '@/components/Text'
import { tap } from '@/lib/haptics'
import { colors } from '@/lib/theme'
import { menuLabel, type ChatMenuAction } from '../model/chat-menu'
import { PIN_COMMIT, PIN_REVEAL, pinSwipeRest } from '../model/chat-swipe'

/** iOS long press uses the system menu and a live preview. Off, and on web and Android, the same actions open in a sheet. */
export const NATIVE_ROW_MENU = true

const REST = { duration: 400, dampingRatio: 0.8, reduceMotion: ReduceMotion.System }
const HOLD_MS = 250

const ICON = {
  read: 'envelope.open',
  unread: 'envelope.badge',
  pin: 'pin',
  unpin: 'pin.slash',
  info: 'info.circle',
  'copy-id': 'doc.on.doc',
} as const

/**
 * A home chat row or pin tile. A swipe toward the leading edge reveals 置顶; a hold of 250 ms then a move drags it.
 * On iOS a still long press is the system context menu with a preview of the chat.
 */
export function HomeRowFrame({ id, href, name, actions, swipe, pinned, open, closeToken, dragX, dragY, onPress, onLongPress, onAction, onCommit, onReveal, onDragStart, onDragMove, onDragEnd, dimmed, tile = false, children }: {
  id: string
  href: string
  name: string
  actions: readonly ChatMenuAction[]
  /** A bot in the list can be pinned this way. A pin tile and a group chat do not swipe. */
  swipe: boolean
  pinned: boolean
  open: boolean
  closeToken: number
  dragX: SharedValue<number>
  dragY: SharedValue<number>
  onPress: () => void
  onLongPress: () => void
  onAction: (action: ChatMenuAction) => void
  onCommit: () => void
  onReveal: (id: string | null) => void
  onDragStart: (id: string, x: number, y: number) => void
  onDragMove: (id: string, x: number, y: number) => void
  onDragEnd: (id: string) => void
  dimmed: boolean
  /** Width for a pin tile, which is a quarter of the grid. */
  tile?: boolean
  children: ReactNode
}) {
  const rtl = I18nManager.isRTL
  const offset = useSharedValue(0)
  const base = useSharedValue(0)
  const nativeMenu = Platform.OS === 'ios' && NATIVE_ROW_MENU
  const handlers = useRef({ onCommit, onReveal, onDragStart, onDragMove, onDragEnd })
  handlers.current = { onCommit, onReveal, onDragStart, onDragMove, onDragEnd }
  const fireStart = useCallback((row: string, x: number, y: number) => handlers.current.onDragStart(row, x, y), [])
  const fireMove = useCallback((row: string, x: number, y: number) => handlers.current.onDragMove(row, x, y), [])
  const fireEnd = useCallback((row: string) => handlers.current.onDragEnd(row), [])
  const menuRef = useRef(onLongPress)
  menuRef.current = onLongPress
  const fireMenu = useCallback(() => menuRef.current(), [])
  const finishSwipe = useCallback((distance: number, velocity: number, towardTrailing: number, rawVelocity: number) => {
    const sign = rtl ? 1 : -1
    if (open && towardTrailing > distance) {
      offset.set(withSpring(0, { ...REST, velocity: rawVelocity }))
      handlers.current.onReveal(null)
      return
    }
    const rest = pinSwipeRest(distance, velocity, open)
    offset.set(withSpring(rest === 'reveal' ? sign * PIN_REVEAL : 0, { ...REST, velocity: rawVelocity }))
    handlers.current.onReveal(rest === 'reveal' ? id : null)
    if (rest === 'commit') handlers.current.onCommit()
  }, [id, offset, open, rtl])

  useEffect(() => {
    if (!open) offset.set(withSpring(0, REST))
  }, [closeToken, offset, open])

  const gesture = useMemo(() => {
    const drag = Gesture.Pan()
      .activateAfterLongPress(HOLD_MS)
      .minDistance(12)
      .onStart(event => { scheduleOnRN(fireStart, id, event.absoluteX, event.absoluteY) })
      .onUpdate(event => {
        dragX.set(event.absoluteX)
        dragY.set(event.absoluteY)
        scheduleOnRN(fireMove, id, event.absoluteX, event.absoluteY)
      })
      .onFinalize(() => { scheduleOnRN(fireEnd, id) })
    const hold = Gesture.LongPress().minDuration(HOLD_MS).maxDistance(12).onStart(() => { scheduleOnRN(fireMenu) })
    if (!swipe) return nativeMenu ? drag : Gesture.Race(drag, hold)
    const pan = Gesture.Pan().failOffsetY([-12, 12])
      .onBegin(() => { base.set(offset.get()) })
      .onUpdate(event => {
        const min = rtl ? 0 : -(PIN_COMMIT + 40)
        const max = rtl ? PIN_COMMIT + 40 : 0
        const next = Math.min(max, Math.max(min, base.get() + event.translationX))
        const before = rtl ? offset.get() : -offset.get()
        const after = rtl ? next : -next
        offset.set(next)
        if ((before < PIN_REVEAL && after >= PIN_REVEAL) || (before < PIN_COMMIT && after >= PIN_COMMIT)) scheduleOnRN(tap)
      })
      .onEnd(event => {
        const distance = rtl ? offset.get() : -offset.get()
        const velocity = rtl ? event.velocityX : -event.velocityX
        const towardTrailing = rtl ? -event.translationX : event.translationX
        scheduleOnRN(finishSwipe, distance, velocity, towardTrailing, event.velocityX)
      })
    if (open) pan.activeOffsetX([-8, 8])
    else pan.activeOffsetX(rtl ? 16 : -16).failOffsetX(rtl ? -10 : 10)
    return nativeMenu ? Gesture.Race(drag, pan) : Gesture.Race(drag, hold, pan)
  }, [base, dragX, dragY, finishSwipe, fireEnd, fireMenu, fireMove, fireStart, id, nativeMenu, offset, open, rtl, swipe])

  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: swipe ? offset.get() : 0 }] }))
  if (Platform.OS === 'web') {
    // The orange pin underlay is only for the native swipe. On web the row stays on the page colour.
    return (
      <View style={tile ? styles.tile : undefined}>
        <Pressable accessibilityRole="button" accessibilityLabel={name} onPress={onPress} onLongPress={onLongPress} delayLongPress={HOLD_MS}
          style={({ pressed }) => [{ backgroundColor: pressed ? colors.pressed : colors.page }, dimmed && styles.dimmed]}>
          {children}
        </Pressable>
      </View>
    )
  }
  const main = actions.filter(action => action !== 'copy-id')
  const more = actions.filter(action => action === 'copy-id')
  const face = nativeMenu ? (
    <Link href={href as Href} asChild>
      <Link.Trigger>
        <Pressable accessibilityRole="button" accessibilityLabel={name} style={dimmed ? styles.dimmed : undefined}>{children}</Pressable>
      </Link.Trigger>
      <Link.Preview />
      <Link.Menu>
        {main.map(action => <Link.MenuAction key={action} title={menuLabel(action)} icon={ICON[action]} onPress={() => onAction(action)} />)}
        {more.length ? (
          <Link.Menu title="更多" icon="ellipsis">
            {more.map(action => <Link.MenuAction key={action} title={menuLabel(action)} icon={ICON[action]} onPress={() => onAction(action)} />)}
          </Link.Menu>
        ) : null}
      </Link.Menu>
    </Link>
  ) : (
    <Pressable accessibilityRole="button" accessibilityLabel={name} onPress={onPress} onLongPress={onLongPress} delayLongPress={HOLD_MS}
      style={({ pressed }) => [pressed && { backgroundColor: colors.pressed }, dimmed && styles.dimmed]}>
      {children}
    </Pressable>
  )

  return (
    <View style={[swipe ? styles.clip : undefined, tile ? styles.tile : undefined]}>
      {swipe ? (
        <Pressable accessibilityRole="button" accessibilityLabel={pinned ? '取消置顶' : '置顶'} onPress={onCommit} style={[styles.action, rtl ? styles.actionLead : styles.actionTrail]}>
          <Text style={styles.actionText}>{pinned ? '取消置顶' : '置顶'}</Text>
        </Pressable>
      ) : null}
      <GestureDetector gesture={gesture}>
        <Animated.View style={[swipe ? styles.face : undefined, slide]}>{face}</Animated.View>
      </GestureDetector>
    </View>
  )
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden', backgroundColor: colors.orange },
  face: { backgroundColor: colors.page },
  dimmed: { opacity: 0.35 },
  action: { position: 'absolute', top: 0, bottom: 0, width: PIN_REVEAL, alignItems: 'center', justifyContent: 'center' },
  actionTrail: { right: 0 },
  actionLead: { left: 0 },
  actionText: { color: colors.onAccent, fontSize: 15, fontWeight: '600' },
  tile: { width: '25%' },
})
