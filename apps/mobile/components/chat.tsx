import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import * as Clipboard from 'expo-clipboard'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Reanimated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'
import { Animated, Image, PanResponder, Pressable, StyleSheet, View, type ImageURISource } from 'react-native'
import { Check, CircleAlert, Copy, Reply } from 'lucide-react-native'
import { StatusIcon } from '@/components/icons'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { press, tap } from '@/lib/haptics'
import { splitQuoted } from '@/lib/quote'
import { authHeaders } from '@/lib/api'
import { API_URL } from '@/lib/config'
import type { Reaction, ThreadStatus } from '@/lib/types'
import { colors } from '@/lib/theme'

/** The bot's words sit in the grey bubble (R-14). */
export function BotBubble({ children }: { children: ReactNode }) {
  return <View style={styles.botBubble}>{children}</View>
}

/** The person's words sit in the blue bubble (R-14); photos they sent sit above it, as in Messages. */
export function MyBubble({ text, photos }: { text: string; photos?: ImageURISource[] }) {
  const { quoted, words } = splitQuoted(text)
  return (
    <View style={styles.mine}>
      {photos?.length ? <Photos photos={photos} /> : null}
      {text ? (
        <View style={[styles.myBubble, { maxWidth: '100%' }]}>
          {quoted ? <Text numberOfLines={3} style={styles.quoted}>{quoted}</Text> : null}
          {words ? <Text style={[styles.body, { color: '#fff' }]}>{words}</Text> : null}
        </View>
      ) : null}
    </View>
  )
}

/** Sent photos, each 160 wide at its own aspect, grey while loading. */
function Photos({ photos }: { photos: ImageURISource[] }) {
  return (
    <View style={styles.photos}>
      {photos.map((source, index) => <Photo key={index} source={source} />)}
    </View>
  )
}

function Photo({ source }: { source: ImageURISource }) {
  const [ratio, setRatio] = useState(3 / 4)
  if (!source.uri) return <View style={[styles.photo, { aspectRatio: ratio }]} />
  return (
    <Image source={source} accessibilityLabel="照片" resizeMode="cover"
      onLoad={event => { const { width, height } = event.nativeEvent.source; if (width && height) setRatio(Math.min(Math.max(width / height, 0.5), 2)) }}
      style={[styles.photo, { aspectRatio: ratio }]} />
  )
}

/** A sent photo as the chat loads it: the person's own message, signed in. */
export function useChatPhotos(): (messageId: string | undefined, count: number | undefined) => ImageURISource[] {
  const [headers, setHeaders] = useState<Record<string, string> | null>(null)
  useEffect(() => { void authHeaders().then(setHeaders) }, [])
  return (messageId, count) => {
    if (!count) return []
    // Still in the inbox (no message row yet): grey stand-ins until the next poll.
    if (!messageId || !headers) return Array.from({ length: count }, () => ({ uri: '' }))
    return Array.from({ length: count }, (_, index) => ({ uri: `${API_URL}/api/mobile/chat/image?message=${messageId}&index=${index}`, headers }))
  }
}

/**
 * A message the server has not taken yet: faded while it goes, and when it
 * failed, 「未发送 · 重试」 under it; tapping either sends it again (iMessage).
 */
export function OutgoingBubble({ text, photos, failed, onRetry }: { text: string; photos?: string[]; failed: boolean; onRetry: () => void }) {
  return (
    <Pressable accessibilityRole={failed ? 'button' : undefined} accessibilityHint={failed ? '重试' : undefined} disabled={!failed} onPress={onRetry} style={styles.outgoing}>
      <View style={[{ alignItems: 'flex-end', gap: 4 }, !failed && { opacity: 0.6 }]}>
        {photos?.length ? <Photos photos={photos.map(uri => ({ uri }))} /> : null}
        {text ? (
          <View style={[styles.myBubble, { maxWidth: '100%' }]}>
            <Text style={[styles.body, { color: '#fff' }]}>{text}</Text>
          </View>
        ) : null}
      </View>
      {failed ? (
        <View style={styles.retryRow}>
          <CircleAlert size={14} color={colors.danger} strokeWidth={2.2} />
          <Text style={styles.retry}>未发送 · 重试</Text>
        </View>
      ) : null}
    </Pressable>
  )
}

/** A thread card: status icon and name, outputs as chips; no step line (R-66). Opens the thread's page. */
export function ThreadCard({ title, status, info, onPress }: { title: string; status: ThreadStatus; info?: string | null; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.threadCard, pressed && { backgroundColor: colors.pressed }]}>
      <StatusIcon status={status} size={20} />
      <View style={{ flex: 1 }}>
        <Text style={styles.threadTitle} numberOfLines={1}>{title}</Text>
        {info ? <Text style={styles.threadInfo} numberOfLines={1}>{info}</Text> : null}
      </View>
    </Pressable>
  )
}

/** Mikka's own event lines (a run ended, an artifact arrived), small and grey between messages. */
export function EventLine({ text }: { text: string }) {
  return <Text style={styles.event} numberOfLines={2}>{text}</Text>
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

/** How far a message is dragged right before letting go quotes it. */
const QUOTE_AT = 56

/**
 * A message row. Dragging it from left to right (not from the screen's edge,
 * which stays the system's swipe back) pulls the message along with a reply
 * arrow behind it; letting go past the mark quotes it in the composer, with a
 * tick, as in iMessage and Claude. A spring takes it back on the UI thread.
 */
export function TimedRow({ time, offset, children, align = 'left', onQuote, onLongPress }: { time?: string; offset: Animated.Value; children: ReactNode; align?: 'left' | 'right'; onQuote?: () => void; onLongPress?: () => void }) {
  const drag = useSharedValue(0)
  const quote = useCallback(() => { tap(); onQuote?.() }, [onQuote])
  const pan = Gesture.Pan()
    .enabled(Boolean(onQuote))
    // Rightward only, and not from the edge: the first 28 points belong to swipe back.
    .activeOffsetX([-10000, 12])
    .failOffsetY([-12, 12])
    .hitSlop({ left: -28 })
    .onUpdate(event => { drag.value = Math.max(0, Math.min(QUOTE_AT * 1.4, event.translationX * 0.8)) })
    .onEnd(() => {
      if (drag.value >= QUOTE_AT) scheduleOnRN(quote)
      drag.value = withSpring(0, { damping: 22, stiffness: 260 })
    })
  const held = useCallback(() => { press(); onLongPress?.() }, [onLongPress])
  // A long press opens the message's actions (app/message.tsx).
  const long = Gesture.LongPress().enabled(Boolean(onLongPress)).minDuration(380).onStart(() => { scheduleOnRN(held) })
  const moved = useAnimatedStyle(() => ({ transform: [{ translateX: drag.value }] }))
  const arrow = useAnimatedStyle(() => ({ opacity: Math.min(1, drag.value / QUOTE_AT), transform: [{ scale: 0.6 + 0.4 * Math.min(1, drag.value / QUOTE_AT) }] }))
  return (
    <GestureDetector gesture={Gesture.Race(pan, long)}>
      <Reanimated.View>
        <Reanimated.View style={[styles.quoteArrow, arrow]} pointerEvents="none">
          <Symbol name="arrowshape.turn.up.left" size={16} color={colors.secondary} web={<Reply size={16} color={colors.secondary} />} />
        </Reanimated.View>
        <Reanimated.View style={moved}>
          <Animated.View style={{ transform: [{ translateX: offset }], alignItems: align === 'right' ? 'flex-end' : 'stretch' }}>
            {children}
            {time ? <Text style={styles.time}>{time}</Text> : null}
          </Animated.View>
        </Reanimated.View>
      </Reanimated.View>
    </GestureDetector>
  )
}

/**
 * Copy under a bot's reply, as in ChatGPT and Claude: the reply's words go to
 * the clipboard and the icon turns into a tick for a moment.
 */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await Clipboard.setStringAsync(text)
    tap()
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={copied ? '已复制' : '复制'} hitSlop={10} onPress={() => void copy()} style={styles.copy}>
      <Symbol name={copied ? 'checkmark' : 'doc.on.doc'} size={15} color={colors.secondary} web={copied ? <Check size={15} color={colors.secondary} /> : <Copy size={15} color={colors.secondary} />} />
    </Pressable>
  )
}

/** Reactions under a message, as in Messages and Slack: each emoji with its count past one; tapping the person's own removes it. */
export function Reactions({ reactions, align = 'left', onToggle }: { reactions?: Reaction[]; align?: 'left' | 'right'; onToggle: (emoji: string) => void }) {
  if (!reactions?.length) return null
  return (
    <View style={[styles.reactions, align === 'right' && { alignSelf: 'flex-end' }]}>
      {reactions.map(reaction => (
        <Pressable key={reaction.emoji} accessibilityRole="button" accessibilityState={{ selected: reaction.mine }} accessibilityLabel={`${reaction.emoji} ${reaction.count}`}
          onPress={() => { tap(); onToggle(reaction.emoji) }} style={[styles.reaction, reaction.mine && styles.reactionMine]}>
          <Text style={styles.reactionText}>{reaction.emoji}{reaction.count > 1 ? ` ${reaction.count}` : ''}</Text>
        </Pressable>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  reactions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  reaction: { height: 28, paddingHorizontal: 9, borderRadius: 14, justifyContent: 'center', backgroundColor: colors.bubble },
  reactionMine: { backgroundColor: '#E3EEFD' },
  reactionText: { fontSize: 14 },
  body: { fontSize: 16, lineHeight: 25 },
  botBubble: { alignSelf: 'flex-start', maxWidth: '86%', backgroundColor: colors.bubble, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 11 },
  myBubble: { alignSelf: 'flex-end', maxWidth: '78%', backgroundColor: colors.accent, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10 },
  quoted: { fontSize: 14, lineHeight: 20, color: 'rgba(255,255,255,0.75)', borderLeftWidth: 2, borderLeftColor: 'rgba(255,255,255,0.6)', paddingLeft: 8, marginBottom: 6 },
  mine: { alignSelf: 'flex-end', alignItems: 'flex-end', maxWidth: '78%', gap: 4 },
  photos: { alignItems: 'flex-end', gap: 4 },
  photo: { width: 160, borderRadius: 18, backgroundColor: colors.bubble },
  outgoing: { alignSelf: 'flex-end', alignItems: 'flex-end', maxWidth: '78%', gap: 4 },
  retryRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  retry: { fontSize: 12, color: colors.danger },
  threadCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.bubble, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 8, minHeight: 52 },
  threadTitle: { fontSize: 16, fontWeight: '500' },
  threadInfo: { fontSize: 12, lineHeight: 16, color: colors.secondary },
  event: { alignSelf: 'center', textAlign: 'center', fontSize: 12, lineHeight: 17, color: colors.secondary, marginHorizontal: 24 },
  time: { position: 'absolute', right: -REVEAL + 6, bottom: 4, fontSize: 11, color: colors.tertiary },
  quoteArrow: { position: 'absolute', left: 4, top: 0, bottom: 0, justifyContent: 'center' },
  copy: { alignSelf: 'flex-start', paddingVertical: 4, paddingHorizontal: 6, marginTop: 2 },
})
