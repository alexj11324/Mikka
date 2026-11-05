import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import * as Clipboard from 'expo-clipboard'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Reanimated, { cancelAnimation, useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming, type SharedValue } from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'
import { AccessibilityInfo, Platform, Pressable, StyleSheet, View, type ImageURISource } from 'react-native'
import { Check, CircleAlert, Copy, Ellipsis, Reply } from 'lucide-react-native'
import { CardButton } from '@/components/cards'
import { MessageMenu, NATIVE_MESSAGE_MENU } from '@/components/MessageMenu'
import type { HeldMessage } from '@/lib/message-actions'
import { ENTER, rubberBand, SNAP_BACK } from '@/lib/springs'
import { QUOTE_DISTANCE, quotes } from '@/lib/message-gesture'
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
export function MyBubble({ text, photos, selecting }: { text: string; photos?: ImageURISource[]; selecting?: ReactNode }) {
  const parsed = splitChatFiles(text)
  const pictures = useImageFiles(parsed.files)
  const { quoted, words } = splitQuoted(parsed.text)
  return (
    <View style={styles.mine}>
      <ChatFiles files={parsed.files.filter(file => !isImageFile(file))} />
      <ChatImages images={[...(photos ?? []), ...pictures]} align="right" />
      {text ? (
        <View style={[styles.myBubble, { maxWidth: '100%' }]}>
          {quoted ? <Text numberOfLines={3} style={styles.quoted}>{quoted}</Text> : null}
          {selecting ?? (words ? <Text style={[styles.body, { color: colors.onAccent }]}>{words}</Text> : null)}
        </View>
      ) : null}
    </View>
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
        {photos?.length ? <ChatImages images={photos.map(uri => ({ uri }))} align="right" /> : null}
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
  const body = (
    <>
      <StatusIcon status={status} size={18} />
      <View style={{ flex: 1 }}>
        <Text style={styles.threadTitle} numberOfLines={1}>{title}</Text>
        {info ? <Text style={styles.threadInfo} numberOfLines={1}>{info}</Text> : null}
      </View>
    </>
  )
  // With an action the card holds two buttons side by side (a button never sits inside another).
  if (action) return (
    <View style={[styles.threadCard, { paddingRight: 8 }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={[title, info].filter(Boolean).join('，')} onPress={onPress} style={({ pressed }) => [styles.threadOpen, pressed && { opacity: 0.6 }]}>{body}</Pressable>
      <CardButton label={action} primary onPress={onPress} />
    </View>
  )
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={[title, info].filter(Boolean).join('，')} onPress={onPress} style={({ pressed }) => [styles.threadCard, pressed && { backgroundColor: colors.pressed }]}>
      {body}
    </Pressable>
  )
}

/**
 * A message that arrived while the chat was open rises into place on a light spring (lib/springs.ts ENTER); what
 * was there when it opened, and everything under Reduce Motion, just appears. It animates its own style rather than
 * a layout (`entering`) animation: inside the virtualized chat list a layout animation could leave the new row
 * invisible.
 */
export function Arrival({ animate, children }: { animate: boolean; children: ReactNode }) {
  const reduceMotion = useReducedMotionPreference()
  const [rises] = useState(() => animate && !reduceMotion)
  const progress = useSharedValue(rises ? 0 : 1)
  useEffect(() => { if (rises) progress.set(withSpring(1, ENTER)) }, [progress, rises])
  const style = useAnimatedStyle(() => ({ opacity: Math.min(1, progress.get()), transform: [{ translateY: (1 - progress.get()) * 8 }] }))
  return <Reanimated.View style={[styles.arrival, style]}>{children}</Reanimated.View>
}

/** Mikka's own event lines (a run ended, an artifact arrived), small and grey between messages. */
export function EventLine({ text }: { text: string }) {
  return <Text style={styles.event} numberOfLines={2}>{text}</Text>
}

const REVEAL = 56

/**
 * Message times are hidden; dragging the chat from right to left reveals each message's time on the right, as in
 * Messages (Figma 01b). One shared value for every row, on the UI thread (expo-animation: Gesture Handler and
 * Reanimated, never PanResponder). The drag locks to an axis, as Messages does: it starts only when the finger moves
 * mostly left, and fails once it moves mostly up or down, so a scroll that has begun keeps the list; while the reveal
 * is on, the list stops scrolling (`scrollLocked`), because a vertical UIScrollView's own pan also starts on a
 * sideways drag. Past the times it rubber-bands, and SNAP_BACK brings it home with the finger's velocity.
 */
export function useTimeReveal() {
  const offset = useSharedValue(0)
  const start = useSharedValue({ x: 0, y: 0 })
  const reduceMotion = useReducedMotionPreference()
  const [scrollLocked, setScrollLocked] = useState(false)
  useEffect(() => { if (reduceMotion) { cancelAnimation(offset); offset.set(0) } }, [offset, reduceMotion])
  const gesture = useMemo(() => Gesture.Pan()
    .manualActivation(true)
    .onTouchesDown(event => { const touch = event.allTouches[0]; if (touch) start.set({ x: touch.absoluteX, y: touch.absoluteY }) })
    .onTouchesMove((event, state) => {
      const touch = event.allTouches[0]
      if (!touch) return
      const dx = touch.absoluteX - start.get().x, dy = touch.absoluteY - start.get().y
      if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) state.fail()
      else if (dx < -10 && Math.abs(dx) > 1.5 * Math.abs(dy)) state.activate()
    })
    .onStart(() => { cancelAnimation(offset); scheduleOnRN(setScrollLocked, true) })
    .onUpdate(event => {
      const x = -event.translationX
      offset.set(x <= REVEAL ? -Math.max(0, x) : -REVEAL - rubberBand(x - REVEAL, REVEAL / 2))
    })
    // Also after a cancelled drag: the list never stays locked. Unlocking an unlocked list renders nothing.
    .onFinalize(event => {
      offset.set(reduceMotion ? 0 : withSpring(0, { ...SNAP_BACK, velocity: event.velocityX }))
      scheduleOnRN(setScrollLocked, false)
    }), [offset, reduceMotion, start])
  return { offset, gesture, scrollLocked }
}

/** How far a message is dragged right before letting go quotes it (`lib/message-gesture.ts`). */
const WEB = Platform.OS === 'web'
const QUOTE_AT = QUOTE_DISTANCE
/** A press opens the message's actions after this long (ms); the bubble starts to give way after `PRESS_IN_DELAY`. */
const HOLD_MS = 500
const PRESS_IN_DELAY = 120
const PRESSED_SCALE = 0.96

/**
 * A message row. Dragging it from left to right (not from the screen's edge,
 * which stays the system's swipe back) pulls the message along with a reply
 * arrow behind it; letting go past the mark quotes it in the composer, with a
 * tick, as in iMessage and Claude. A spring takes it back on the UI thread.
 */
export function TimedRow({ time, offset, children, align = 'left', onQuote, onLongPress, menu }: { time?: string; offset: SharedValue<number>; children: ReactNode; align?: 'left' | 'right'; onQuote?: () => void; onLongPress?: () => void; menu?: HeldMessage }) {
  const drag = useSharedValue(0)
  const reduceMotion = useReducedMotionPreference()
  const quote = useCallback(() => { tap(); onQuote?.() }, [onQuote])
  // On the web a mouse drag also selects the bubble's text: while the bubble is dragged, its text can't be selected
  // and the selection the press started is cleared. Selecting text works again once it is let go.
  const [dragging, setDragging] = useState(false)
  const dragStarted = useCallback(() => { setDragging(true); globalThis.getSelection?.()?.removeAllRanges() }, [])
  const dragEnded = useCallback(() => { setDragging(false) }, [])
  const pan = Gesture.Pan()
    .enabled(Boolean(onQuote))
    // Rightward only, and not from the edge: the first 28 points belong to swipe back. It starts after 16 points to
    // the right and gives way at once to a leftward move (the times) or to 12 points up or down (scrolling).
    .activeOffsetX(16)
    .failOffsetX(-8)
    .failOffsetY([-12, 12])
    .hitSlop({ left: -28 })
    .onStart(() => { cancelAnimation(drag); if (WEB) scheduleOnRN(dragStarted) })
    // Follows the finger with rubber-band resistance (lib/springs.ts), easing towards twice the mark, never a hard stop.
    .onUpdate(event => { drag.value = rubberBand(event.translationX, QUOTE_AT * 2) })
    .onEnd((event, success) => {
      if (success && quotes(drag.value, event.velocityX)) scheduleOnRN(quote)
    })
    // Finalize also runs for an interrupted/cancelled drag; cancellation never
    // quotes the message and must not leave its bubble stuck off its baseline.
    .onFinalize(event => {
      drag.value = reduceMotion ? 0 : withSpring(0, { ...SNAP_BACK, velocity: event.velocityX })
      if (WEB) scheduleOnRN(dragEnded)
    })
  const held = useCallback(() => { press(); onLongPress?.() }, [onLongPress])
  // A long press opens the message's actions: on iOS the system context menu (MessageMenu), elsewhere the sheet
  // (app/message.tsx). VoiceOver and the keyboard reach the sheet through the frame below on every platform.
  const native = NATIVE_MESSAGE_MENU && Boolean(menu)
  // While a finger rests on the bubble it gives way a little (after 120 ms, so a tap or a scroll never shows it), and
  // the actions open at 500 ms; letting go or scrolling springs it back.
  const pressed = useSharedValue(1)
  const long = Gesture.LongPress().enabled(Boolean(onLongPress) && !native).minDuration(HOLD_MS)
    .onBegin(() => { if (!reduceMotion) pressed.value = withDelay(PRESS_IN_DELAY, withTiming(PRESSED_SCALE, { duration: HOLD_MS - PRESS_IN_DELAY })) })
    .onStart(() => { scheduleOnRN(held) })
    .onFinalize(() => { pressed.value = reduceMotion ? 1 : withSpring(1, SNAP_BACK) })
  const moved = useAnimatedStyle(() => ({ transform: [{ translateX: drag.value }, { scale: pressed.value }] }))
  const revealed = useAnimatedStyle(() => ({ transform: [{ translateX: offset.get() }] }))
  const arrow = useAnimatedStyle(() => ({ opacity: Math.min(1, drag.value / QUOTE_AT), transform: [{ scale: reduceMotion ? 1 : 0.6 + 0.4 * Math.min(1, drag.value / QUOTE_AT) }] }))
  return (
    <View>
    <GestureDetector gesture={Gesture.Race(pan, long)}>
      <Reanimated.View style={dragging ? styles.unselectable : undefined}>
        <Reanimated.View style={[styles.quoteArrow, arrow]} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden>
          <Symbol name="arrowshape.turn.up.left" size={15} color={colors.secondary} web={<Reply size={15} color={colors.secondary} />} />
        </Reanimated.View>
        <Reanimated.View style={moved}>
          <Reanimated.View style={[revealed, { alignItems: align === 'right' ? 'flex-end' : 'stretch' }]}>
            {native ? <MessageMenu message={menu}><View style={{ alignItems: align === 'right' ? 'flex-end' : 'stretch' }}>{children}</View></MessageMenu> : children}
            {time ? <Text style={styles.time}>{time}</Text> : null}
          </Reanimated.View>
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
      <Pressable accessibilityRole="button" accessibilityLabel="回复" hitSlop={6} onPress={() => { tap(); onQuote() }} style={({ pressed }) => [styles.copy, pressed && { backgroundColor: colors.pressed }]}>
        <Symbol name="arrowshape.turn.up.left" size={14} color={colors.secondary} web={<Reply size={14} color={colors.secondary} />} />
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="更多" hitSlop={6} onPress={onMore} style={({ pressed }) => [styles.copy, pressed && { backgroundColor: colors.pressed }]}>
        <Symbol name="ellipsis" size={14} color={colors.secondary} web={<Ellipsis size={14} color={colors.secondary} />} />
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
    <Pressable accessibilityRole="button" accessibilityLabel={copied ? '已复制' : '复制'} hitSlop={6} onPress={() => void copy()} style={({ pressed }) => [styles.copy, pressed && { backgroundColor: colors.pressed }]}>
      <Symbol name={copied ? 'checkmark' : 'doc.on.doc'} size={14} color={colors.secondary} web={copied ? <Check size={14} color={colors.secondary} /> : <Copy size={14} color={colors.secondary} />} />
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
  outgoing: { alignSelf: 'flex-end', alignItems: 'flex-end', maxWidth: '78%', gap: 4 },
  retryRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  retry: { fontSize: 12, color: colors.danger },
  threadCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.bubble, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 8, minHeight: 52 },
  // The list's 12-point gap between a message and the cards that follow it.
  arrival: { gap: 12 },
  threadOpen: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
  threadTitle: { fontSize: 16, fontWeight: '500' },
  threadInfo: { fontSize: 12, lineHeight: 16, color: colors.secondary },
  event: { alignSelf: 'center', textAlign: 'center', fontSize: 12, lineHeight: 17, color: colors.secondary, marginHorizontal: 24 },
  time: { position: 'absolute', right: -REVEAL + 6, bottom: 4, fontSize: 11, color: colors.secondary },
  // Web only: the bubble's text is not selected while it is dragged (TimedRow).
  unselectable: { userSelect: 'none' } as never,
  quoteArrow: { position: 'absolute', left: 4, top: 0, bottom: 0, justifyContent: 'center' },
  // A 32-point button whose 6-point hitSlop keeps the 44-point target (the glyph at text size, as in ChatGPT and Claude).
  copy: { alignSelf: 'flex-start', width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  // The icons' own 44-point targets sit flush with the bubble's left edge, a little under it.
  replyActions: { flexDirection: 'row', alignSelf: 'flex-start', gap: 4, marginLeft: -8, marginTop: -4, marginBottom: -4 },
})
import { splitChatFiles } from '@mikka/protocol/chat-attachments'
import { ChatFiles } from './ChatFiles'
import { ChatImages } from '@/features/chat/components/chat-images'
import { isImageFile, useImageFiles } from '@/features/chat/model/chat-image-source'
