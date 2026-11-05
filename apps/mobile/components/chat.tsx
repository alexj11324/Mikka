import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Clipboard from 'expo-clipboard'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Reanimated, { cancelAnimation, FadeInDown, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'
import { AccessibilityInfo, Animated, Image, PanResponder, Platform, Pressable, StyleSheet, View, type ImageURISource } from 'react-native'
import { Check, CircleAlert, Copy, Ellipsis, Reply } from 'lucide-react-native'
import { CardButton } from '@/components/cards'
import { ENTER, rubberBand, SNAP_BACK } from '@/lib/springs'
import { StatusIcon } from '@/components/icons'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { press, tap } from '@/lib/haptics'
import { splitQuoted } from '@/lib/quote'
import { authHeaders } from '@/lib/api'
import { API_URL } from '@/lib/config'
import type { Reaction, ThreadStatus } from '@/lib/types'
import { colors } from '@/lib/theme'
import { useReducedMotionPreference } from '@/lib/reduced-motion'

/** The bot's words sit in the grey bubble (R-14). */
export function BotBubble({ children }: { children: ReactNode }) {
  return <View style={styles.botBubble}>{children}</View>
}

/** The person's words sit in the blue bubble (R-14); photos they sent sit above it, as in Messages. */
export function MyBubble({ text, photos }: { text: string; photos?: ImageURISource[] }) {
  const parsed = splitChatFiles(text)
  const { quoted, words } = splitQuoted(parsed.text)
  return (
    <View style={styles.mine}>
      <ChatFiles files={parsed.files} />
      {photos?.length ? <Photos photos={photos} /> : null}
      {text ? (
        <View style={[styles.myBubble, { maxWidth: '100%' }]}>
          {quoted ? <Text numberOfLines={3} style={styles.quoted}>{quoted}</Text> : null}
          {words ? <Text style={[styles.body, { color: colors.onAccent }]}>{words}</Text> : null}
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
 * A pending message keeps its words and its retry action. Missing receipts say
 * 未确认; only a known server refusal says 未发送.
 */
export function OutgoingBubble({ text, photos, failed, unconfirmed = false, onRetry }: { text: string; photos?: string[]; failed: boolean; unconfirmed?: boolean; onRetry: () => void }) {
  return (
    <Pressable accessibilityRole={failed ? 'button' : undefined} accessibilityHint={failed ? '重试' : undefined} disabled={!failed} onPress={onRetry} style={styles.outgoing}>
      <View style={[{ alignItems: 'flex-end', gap: 4 }, !failed && { opacity: 0.6 }]}>
        {photos?.length ? <Photos photos={photos.map(uri => ({ uri }))} /> : null}
        {text ? (
          <View style={[styles.myBubble, { maxWidth: '100%' }]}>
            <Text style={[styles.body, { color: colors.onAccent }]}>{text}</Text>
          </View>
        ) : null}
      </View>
      {failed ? (
        <View style={styles.retryRow}>
          <CircleAlert size={14} color={colors.danger} strokeWidth={2.2} />
          <Text style={styles.retry}>{unconfirmed ? '发送未确认 · 重试' : '未发送 · 重试'}</Text>
        </View>
      ) : null}
    </Pressable>
  )
}

/**
 * A thread card: status icon and name, outputs as chips; no step line (R-66). Opens the thread's page. A thread
 * waiting for the person carries its action (去回答, #1386); a long name is cut here and read in full on its page.
 */
export function ThreadCard({ title, status, info, onPress, action }: { title: string; status: ThreadStatus; info?: string | null; onPress: () => void; action?: string }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={[title, info].filter(Boolean).join('，')} accessibilityHint={action} onPress={onPress} style={({ pressed }) => [styles.threadCard, pressed && { backgroundColor: colors.pressed }]}>
      <StatusIcon status={status} size={20} />
      <View style={{ flex: 1 }}>
        <Text style={styles.threadTitle} numberOfLines={1}>{title}</Text>
        {info ? <Text style={styles.threadInfo} numberOfLines={1}>{info}</Text> : null}
      </View>
      {action ? <CardButton label={action} primary onPress={onPress} /> : null}
    </Pressable>
  )
}

const ARRIVE = FadeInDown.springify().mass(ENTER.mass).stiffness(ENTER.stiffness).damping(ENTER.damping)
  .withInitialValues({ opacity: 0, transform: [{ translateY: 8 }] })

/**
 * A message that arrived while the chat was open rises into place on a light spring (lib/springs.ts ENTER); what
 * was there when it opened, and everything under Reduce Motion, just appears.
 */
export function Arrival({ animate, children }: { animate: boolean; children: ReactNode }) {
  const reduceMotion = useReducedMotionPreference()
  return <Reanimated.View entering={animate && !reduceMotion ? ARRIVE : undefined}>{children}</Reanimated.View>
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
  const reduceMotion = useReducedMotionPreference()
  const preference = useRef(reduceMotion)
  preference.current = reduceMotion
  useEffect(() => {
    if (reduceMotion) { offset.stopAnimation(); offset.setValue(0) }
    return () => offset.stopAnimation()
  }, [offset, reduceMotion])
  const responder = useMemo(() => {
    const reset = () => {
      offset.stopAnimation()
      if (preference.current) offset.setValue(0)
      else Animated.spring(offset, { toValue: 0, useNativeDriver: Platform.OS !== 'web', ...SNAP_BACK }).start()
    }
    return PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => g.dx < -8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
    onPanResponderGrant: () => offset.stopAnimation(),
    // Past the times the drag meets rubber-band resistance instead of a wall.
    onPanResponderMove: (_, g) => offset.setValue(g.dx >= -REVEAL ? Math.min(0, g.dx) : -REVEAL - rubberBand(-g.dx - REVEAL, REVEAL / 2)),
    onPanResponderRelease: reset,
    onPanResponderTerminate: reset,
    })
  }, [offset])
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
  const reduceMotion = useReducedMotionPreference()
  const quote = useCallback(() => { tap(); onQuote?.() }, [onQuote])
  const pan = Gesture.Pan()
    .enabled(Boolean(onQuote))
    // Rightward only, and not from the edge: the first 28 points belong to swipe back.
    .activeOffsetX([-10000, 12])
    .failOffsetY([-12, 12])
    .hitSlop({ left: -28 })
    .onStart(() => { cancelAnimation(drag) })
    // Follows the finger with rubber-band resistance (lib/springs.ts), easing towards twice the mark, never a hard stop.
    .onUpdate(event => { drag.value = rubberBand(event.translationX, QUOTE_AT * 2) })
    .onEnd((_event, success) => {
      if (success && drag.value >= QUOTE_AT) scheduleOnRN(quote)
    })
    // Finalize also runs for an interrupted/cancelled drag; cancellation never
    // quotes the message and must not leave its bubble stuck off its baseline.
    .onFinalize(event => { drag.value = reduceMotion ? 0 : withSpring(0, { ...SNAP_BACK, velocity: event.velocityX }) })
  const held = useCallback(() => { press(); onLongPress?.() }, [onLongPress])
  // A long press opens the message's actions (app/message.tsx).
  const long = Gesture.LongPress().enabled(Boolean(onLongPress)).minDuration(380).onStart(() => { scheduleOnRN(held) })
  const moved = useAnimatedStyle(() => ({ transform: [{ translateX: drag.value }] }))
  const arrow = useAnimatedStyle(() => ({ opacity: Math.min(1, drag.value / QUOTE_AT), transform: [{ scale: reduceMotion ? 1 : 0.6 + 0.4 * Math.min(1, drag.value / QUOTE_AT) }] }))
  return (
    <View>
    <GestureDetector gesture={Gesture.Race(pan, long)}>
      <Reanimated.View>
        <Reanimated.View style={[styles.quoteArrow, arrow]} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden>
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
    {onLongPress || onQuote ? (
      <Pressable accessibilityRole="button" accessibilityLabel={`${time ? `${time}，` : ''}${onLongPress ? '消息操作' : '引用消息'}`} focusable
        accessibilityActions={[
          { name: 'activate', label: onLongPress ? '消息操作' : '引用消息' },
          ...(onQuote ? [{ name: 'quote', label: '引用消息' }] : []),
          ...(time ? [{ name: 'time', label: `时间：${time}` }] : []),
        ]}
        onAccessibilityAction={event => {
          if (event.nativeEvent.actionName === 'quote') quote()
          else if (event.nativeEvent.actionName === 'time' && time) AccessibilityInfo.announceForAccessibility(time)
          else if (event.nativeEvent.actionName === 'activate') { if (onLongPress) held(); else quote() }
        }}
        onPress={onLongPress ? held : quote}
        // No button of its own on screen (#1386): touch goes to the message (long press, drag); VoiceOver and
        // the keyboard reach the same actions on this frame over it.
        pointerEvents="none" style={StyleSheet.absoluteFill} />
    ) : null}
    </View>
  )
}

/**
 * The one row under the bot's latest reply (#1386), as in ChatGPT and Claude: 复制, 回复 (quote it) and 更多 (the
 * message's actions, as a long press opens them). Older replies and the person's own messages: long press.
 */
export function ReplyActions({ text, onQuote, onMore }: { text: string; onQuote: () => void; onMore: () => void }) {
  return (
    <View style={styles.replyActions}>
      <CopyButton text={text} />
      <Pressable accessibilityRole="button" accessibilityLabel="回复" onPress={() => { tap(); onQuote() }} style={({ pressed }) => [styles.copy, pressed && { backgroundColor: colors.pressed }]}>
        <Symbol name="arrowshape.turn.up.left" size={15} color={colors.secondary} web={<Reply size={15} color={colors.secondary} />} />
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="更多" onPress={onMore} style={({ pressed }) => [styles.copy, pressed && { backgroundColor: colors.pressed }]}>
        <Symbol name="ellipsis" size={15} color={colors.secondary} web={<Ellipsis size={15} color={colors.secondary} />} />
      </Pressable>
    </View>
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
    <Pressable accessibilityRole="button" accessibilityLabel={copied ? '已复制' : '复制'} onPress={() => void copy()} style={({ pressed }) => [styles.copy, pressed && { backgroundColor: colors.pressed }]}>
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
          accessibilityHint={reaction.mine ? '移除回应' : '添加回应'}
          onPress={() => { tap(); onToggle(reaction.emoji) }} style={({ pressed }) => [styles.reactionTarget, pressed && { opacity: 0.6 }]}>
          <View style={[styles.reaction, reaction.mine && styles.reactionMine]}>
          <Text style={styles.reactionText}>{reaction.emoji}{reaction.count > 1 ? ` ${reaction.count}` : ''}</Text>
          </View>
        </Pressable>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  reactions: { flexDirection: 'row', flexWrap: 'wrap', gap: 2, marginTop: 4 },
  reactionTarget: { minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 2, paddingVertical: 8 },
  reaction: { height: 28, paddingHorizontal: 9, borderRadius: 14, justifyContent: 'center', backgroundColor: colors.bubble },
  reactionMine: { backgroundColor: colors.objectChip },
  reactionText: { fontSize: 14 },
  body: { fontSize: 16, lineHeight: 25 },
  botBubble: { alignSelf: 'flex-start', maxWidth: '86%', backgroundColor: colors.bubble, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 11 },
  myBubble: { alignSelf: 'flex-end', maxWidth: '78%', backgroundColor: colors.accentFill, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10 },
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
  time: { position: 'absolute', right: -REVEAL + 6, bottom: 4, fontSize: 11, color: colors.secondary },
  quoteArrow: { position: 'absolute', left: 4, top: 0, bottom: 0, justifyContent: 'center' },
  copy: { alignSelf: 'flex-start', minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
  // The icons' own 44-point targets sit flush with the bubble's left edge, a little under it.
  replyActions: { flexDirection: 'row', alignSelf: 'flex-start', marginLeft: -12, marginTop: -2, marginBottom: -10 },
})
import { splitChatFiles } from '@mikka/protocol/chat-attachments'
import { ChatFiles } from './ChatFiles'
