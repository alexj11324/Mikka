import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { Pin, PinOff } from 'lucide-react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Reanimated, { useAnimatedStyle, useSharedValue, withSpring, type SharedValue } from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'
import { ChatRowContent } from '@/components/ChatList'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { tap, warn } from '@/lib/haptics'
import { useReducedMotionPreference } from '@/lib/reduced-motion'
import { SNAP_BACK } from '@/lib/springs'
import { colors } from '@/lib/theme'
import { armedAt, PIN_REVEAL, settleSwipe } from '../model/pin-swipe'
import type { HomeChat, useHomeChats } from '../model/use-home-chats'
import { ChatBadge } from './chat-badge'
import { useChatDrag } from './chat-drag'
import { ChatLink } from './chat-link'

type Actions = ReturnType<typeof useHomeChats>

/**
 * A chat on the home list (#1408 Phase 2b). A tap opens it with the system's link transition; a long press opens its
 * menu over a live preview of the chat (chat-menu.tsx). A swipe to the left shows 置顶 at 88 pt and pins on release
 * past 144 pt, with a tick as it crosses (pin-swipe.ts); on a closed row a swipe to the right is the drawer's, and on
 * an open row it closes the row. Holding 250 ms and moving drags it instead (chat-drag.tsx): the two race, and the
 * first to start wins.
 */
export function HomeChatRow({ chat, actions, openKey, onOpen }: { chat: HomeChat; actions: Actions; openKey: string | null; onOpen: (key: string | null) => void }) {
  const reduceMotion = useReducedMotionPreference()
  const offset = useSharedValue(0)
  const start = useSharedValue(0)
  const armed = useSharedValue(false)
  const [open, setOpen] = useState(false)
  const drag = useChatDrag(chat.key, 'list')
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
  // A press that ends a swipe or a drag is not a tap. iOS cancels the press itself; the web build does not.
  const swiping = useRef(false)
  const setSwiping = useCallback((value: boolean) => { swiping.current = value }, [])
  const endSwipe = useCallback(() => { setTimeout(() => { swiping.current = false }, 0) }, [])

  const swipe = useMemo(() => Gesture.Pan()
    // Left at once; right only to close an open row, so a closed row leaves a drag to the right to the drawer.
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
      else if (outcome === 'open') { settleTo(-PIN_REVEAL); scheduleOnRN(opened, true) }
      else { settleTo(0); scheduleOnRN(opened, false) }
    }), [armed, blocked, chat.key, offset, onOpen, open, opened, pin, settleTo, start])
  const gesture = useMemo(() => Gesture.Race(drag.gesture, swipe), [drag.gesture, swipe])

  const moved = useAnimatedStyle(() => ({ transform: [{ translateX: offset.get() }] }))
  return (
    <View style={styles.clip}>
      <PinAction chat={chat} offset={offset} blocked={blocked} onPress={() => { close(); if (blocked) warn(); else pin() }} />
      <GestureDetector gesture={gesture}>
        <Reanimated.View ref={drag.ref} collapsable={false} style={[styles.surface, moved]}>
          <ChatLink chat={chat} actions={actions} ignore={() => swiping.current || drag.active()} style={({ pressed }) => pressed && { backgroundColor: colors.pressed }}>
            <ChatRowContent row={chat.row} badge={<ChatBadge chat={chat} />} />
          </ChatLink>
          {/* An open row: a tap on it closes it rather than opening the chat. */}
          {open ? <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel="收起" onPress={close} /> : null}
        </Reanimated.View>
      </GestureDetector>
    </View>
  )
}

/** The action under a swiped row: 置顶 or 取消置顶, growing with the swipe; grey when the pins are full. */
function PinAction({ chat, offset, blocked, onPress }: { chat: HomeChat; offset: SharedValue<number>; blocked: boolean; onPress: () => void }) {
  const grow = useAnimatedStyle(() => ({ width: Math.max(PIN_REVEAL, -offset.get()), opacity: offset.get() < 0 ? 1 : 0 }))
  return (
    <Reanimated.View style={[styles.action, { backgroundColor: blocked ? colors.tertiary : colors.orange }, grow]}>
      <Pressable accessibilityRole="button" accessibilityLabel={chat.pinned ? '取消置顶' : '置顶'} onPress={onPress} style={styles.actionButton}>
        <Symbol name={chat.pinned ? 'pin.slash.fill' : 'pin.fill'} size={20} color={colors.onAccent}
          web={chat.pinned ? <PinOff size={20} color={colors.onAccent} strokeWidth={2} /> : <Pin size={20} color={colors.onAccent} strokeWidth={2} />} />
        <Text style={styles.actionLabel}>{chat.pinned ? '取消置顶' : '置顶'}</Text>
      </Pressable>
    </Reanimated.View>
  )
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  surface: { backgroundColor: colors.page },
  action: { position: 'absolute', right: 0, top: 0, bottom: 0, justifyContent: 'center' },
  actionButton: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4 },
  actionLabel: { fontSize: 12.5, lineHeight: 16, fontWeight: '600', color: colors.onAccent },
})
