import { mobileMessages } from '@/lib/messages'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { EyeOff, Pin, PinOff } from 'lucide-react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Reanimated, { useAnimatedStyle, useSharedValue, withSpring, type SharedValue } from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'
import { ChatRowContent } from '@/components/ChatList'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { tap, warn } from '@/lib/haptics'
import { useReducedMotionPreference } from '@/lib/reduced-motion'
import { SNAP_BACK } from '@/lib/springs'
import { colors, ROW_SURFACE_INSET } from '@/lib/theme'
import { armedAt, settleSwipe, SWIPE_REVEAL } from '../model/pin-swipe'
import type { HomeChat, useHomeChats } from '../model/use-home-chats'
import { ChatBadge } from './chat-badge'
import { ChatLink } from './chat-link'

type Actions = ReturnType<typeof useHomeChats>

/**
 * A chat on the home list (#1408 Phase 2b). A tap opens it with the system's link transition; a long press opens its
 * menu over a live preview of the chat (chat-menu.tsx). A swipe to the left shows two capsules, 置顶 and 隐藏 (Comma
 * design 03), and pins on release past the full mark, with a tick as it crosses (pin-swipe.ts); a swipe to the right only closes an open row. Chats are not dragged (Alex 2026-11-07).
 */
export function HomeChatRow({ chat, actions, openKey, onOpen }: { chat: HomeChat; actions: Actions; openKey: string | null; onOpen: (key: string | null) => void }) {
  const reduceMotion = useReducedMotionPreference()
  const offset = useSharedValue(0)
  const start = useSharedValue(0)
  const armed = useSharedValue(false)
  const [open, setOpen] = useState(false)
  const blocked = actions.pinsFull && !chat.pinned

  const settleTo = useCallback((to: number) => {
    'worklet'
    offset.set(reduceMotion ? to : withSpring(to, SNAP_BACK))
  }, [offset, reduceMotion])
  const pin = useCallback(() => { void actions.togglePin(chat, false) }, [actions, chat])
  const close = useCallback(() => { settleTo(0); setOpen(false) }, [settleTo])
  // One row is open at a time: another row opening, or the list scrolling, closes this one.
  useEffect(() => { if (open && openKey !== chat.key) close() }, [chat.key, close, open, openKey])
  const opened = useCallback((value: boolean) => { setOpen(value); if (value) onOpen(chat.key) }, [chat.key, onOpen])
  // A press that ends a swipe is not a tap. iOS cancels the press itself; the web build does not.
  const swiping = useRef(false)
  const setSwiping = useCallback((value: boolean) => { swiping.current = value }, [])
  const endSwipe = useCallback(() => { setTimeout(() => { swiping.current = false }, 0) }, [])

  const swipe = useMemo(() => Gesture.Pan()
    // Left at once; right only to close an open row.
    .activeOffsetX(open ? [-10, 10] : -10)
    .failOffsetX(open ? 10_000 : 10)
    .failOffsetY([-10, 10])
    .onStart(() => { start.set(offset.get()); armed.set(false); scheduleOnRN(setSwiping, true); scheduleOnRN(onOpen, chat.key) })
    .onFinalize(() => { scheduleOnRN(endSwipe) })
    .onUpdate(event => {
      const next = Math.min(0, start.get() + event.translationX)
      offset.set(next)
      const was = armed.get(), now = armedAt(-next, was)
      if (now !== was) {
        armed.set(now && !blocked)
        if (now) scheduleOnRN(blocked ? warn : tap)
      }
    })
    .onEnd(event => {
      const outcome = settleSwipe(offset.get(), event.velocityX, armed.get())
      armed.set(false)
      if (outcome === 'pin') { settleTo(0); scheduleOnRN(opened, false); scheduleOnRN(pin) }
      else if (outcome === 'open') { settleTo(-SWIPE_REVEAL); scheduleOnRN(opened, true) }
      else { settleTo(0); scheduleOnRN(opened, false) }
    }), [armed, blocked, chat.key, offset, onOpen, open, opened, pin, settleTo, start])

  const moved = useAnimatedStyle(() => ({ transform: [{ translateX: offset.get() }] }))
  return (
    <View style={styles.clip}>
      <SwipeActions chat={chat} offset={offset} blocked={blocked}
        onPin={() => { close(); if (blocked) warn(); else pin() }}
        onHide={() => { close(); void actions.setHidden(chat, true) }} />
      <GestureDetector gesture={swipe}>
        <Reanimated.View style={[styles.surface, moved]}>
          {/* The side margin sits on a plain View: on iOS the press is inside a Link, which may not pass a style on. */}
          <View style={styles.inset}>
            <ChatLink chat={chat} actions={actions} ignore={() => swiping.current} style={({ pressed }) => [styles.press, pressed && { backgroundColor: colors.pressed }]}>
              <ChatRowContent row={chat.row} badge={<ChatBadge chat={chat} />} />
            </ChatLink>
          </View>
          {/* An open row: a tap on it closes it rather than opening the chat. */}
          {open ? <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel={mobileMessages.MobileCore.collapseRow} onPress={close} /> : null}
        </Reanimated.View>
      </GestureDetector>
    </View>
  )
}

/** The capsules under a swiped row: 置顶 or 取消置顶 (orange; grey when the pins are full) and 隐藏 (grey). */
function SwipeActions({ chat, offset, blocked, onPin, onHide }: { chat: HomeChat; offset: SharedValue<number>; blocked: boolean; onPin: () => void; onHide: () => void }) {
  const shown = useAnimatedStyle(() => ({ width: Math.max(SWIPE_REVEAL, -offset.get()), opacity: Math.min(1, -offset.get() / (SWIPE_REVEAL / 2)) }))
  const pinLabel = chat.pinned ? mobileMessages.MobileCore.unpin : mobileMessages.MobileCore.pin
  return (
    <Reanimated.View style={[styles.actions, shown]}>
      <Capsule label={pinLabel} color={blocked ? colors.tertiary : colors.orange} onPress={onPin}
        icon={<Symbol name={chat.pinned ? 'pin.slash.fill' : 'pin.fill'} size={19} color={colors.onAccent}
          web={chat.pinned ? <PinOff size={19} color={colors.onAccent} strokeWidth={2} /> : <Pin size={19} color={colors.onAccent} strokeWidth={2} />} />} />
      <Capsule label={mobileMessages.MobileCore.hide} color={colors.tertiary} onPress={onHide}
        icon={<Symbol name="eye.slash.fill" size={19} color={colors.onAccent} web={<EyeOff size={19} color={colors.onAccent} strokeWidth={2} />} />} />
    </Reanimated.View>
  )
}

function Capsule({ label, color, icon, onPress }: { label: string; color: string; icon: ReactNode; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [styles.capsuleButton, pressed && { opacity: 0.7 }]}>
      <View style={[styles.capsule, { backgroundColor: color }]}>{icon}</View>
      <Text style={styles.capsuleLabel} numberOfLines={1}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  surface: { backgroundColor: colors.page },
  /** The pressed surface sits 6 pt in from each side, rounded 10; the row's text lands 16 pt in (lib/theme.ts). */
  inset: { marginHorizontal: ROW_SURFACE_INSET },
  press: { borderRadius: 10 },
  actions: { position: 'absolute', right: 0, top: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 10, paddingRight: 14 },
  capsuleButton: { alignItems: 'center', gap: 4 },
  capsule: { width: 58, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  capsuleLabel: { fontSize: 12, lineHeight: 15, color: colors.secondary },
})
