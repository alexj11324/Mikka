import { type ReactNode, useRef } from 'react'
import { Animated, PanResponder, Pressable, StyleSheet, View } from 'react-native'
import { StatusIcon } from '@/components/icons'
import { Text } from '@/components/Text'
import type { ThreadStatus } from '@/lib/types'
import { colors } from '@/lib/theme'

/** The bot's words sit in the grey bubble (R-14). */
export function BotBubble({ children }: { children: ReactNode }) {
  return <View style={styles.botBubble}>{children}</View>
}

/** The person's words sit in the blue bubble (R-14). */
export function MyBubble({ text }: { text: string }) {
  return (
    <View style={styles.myBubble}>
      <Text style={[styles.body, { color: '#fff' }]}>{text}</Text>
    </View>
  )
}

/** A thread card: status icon and name, outputs as chips; no step line (R-66). Opens the thread's page. */
export function ThreadCard({ title, status, onPress }: { title: string; status: ThreadStatus; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.threadCard, pressed && { backgroundColor: colors.pressed }]}>
      <StatusIcon status={status} size={20} />
      <Text style={styles.threadTitle} numberOfLines={1}>{title}</Text>
    </Pressable>
  )
}

/** Mikka's own event lines (a run ended, an artifact arrived), small and grey between messages. */
export function EventLine({ text }: { text: string }) {
  return <Text style={styles.event} numberOfLines={2}>{text}</Text>
}

/** Briefing date label, centred (Hark). The only time shown without a swipe. */
export function DateLabel({ text }: { text: string }) {
  return <Text style={styles.dateLabel}>{text}</Text>
}

const REVEAL = 56

/**
 * Message times are hidden; dragging the chat from right to left reveals each
 * message's time on the right, as in iMessage (Figma 01b).
 */
export function useTimeReveal() {
  const offset = useRef(new Animated.Value(0)).current
  const responder = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => g.dx < -8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
    onPanResponderMove: (_, g) => offset.setValue(Math.max(-REVEAL, Math.min(0, g.dx))),
    onPanResponderRelease: () => Animated.spring(offset, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start(),
    onPanResponderTerminate: () => Animated.spring(offset, { toValue: 0, useNativeDriver: true }).start(),
  })).current
  return { offset, handlers: responder.panHandlers }
}

export function TimedRow({ time, offset, children, align = 'left' }: { time?: string; offset: Animated.Value; children: ReactNode; align?: 'left' | 'right' }) {
  return (
    <Animated.View style={{ transform: [{ translateX: offset }], alignItems: align === 'right' ? 'flex-end' : 'stretch' }}>
      {children}
      {time ? <Text style={styles.time}>{time}</Text> : null}
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  body: { fontSize: 16, lineHeight: 25 },
  botBubble: { alignSelf: 'flex-start', maxWidth: '86%', backgroundColor: colors.bubble, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 11 },
  myBubble: { alignSelf: 'flex-end', maxWidth: '78%', backgroundColor: colors.accent, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10 },
  threadCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.bubble, borderRadius: 18, paddingHorizontal: 16, height: 52 },
  threadTitle: { flex: 1, fontSize: 16, fontWeight: '500' },
  event: { alignSelf: 'center', textAlign: 'center', fontSize: 12, lineHeight: 17, color: colors.secondary, marginHorizontal: 24 },
  dateLabel: { alignSelf: 'center', fontSize: 12, color: colors.secondary, marginVertical: 4 },
  time: { position: 'absolute', right: -REVEAL + 6, bottom: 4, fontSize: 11, color: colors.tertiary },
})
