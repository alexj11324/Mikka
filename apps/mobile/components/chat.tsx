import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import * as Clipboard from 'expo-clipboard'
import { router } from 'expo-router'
import { personReferenceParts } from '../../../lib/thread-references'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Reanimated, { useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming } from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'
import { Linking, Pressable, StyleSheet, View, type ImageURISource } from 'react-native'
import { Check, CircleAlert, Copy } from 'lucide-react-native'
import { CardButton } from '@/components/cards'
import { MessageMenu } from '@/components/MessageMenu'
import type { HeldMessage } from '@/lib/message-actions'
import { ENTER, SNAP_BACK } from '@/lib/springs'
import { StatusIcon } from '@/components/icons'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { mobileMessages } from '@/lib/messages'
import { press, tap } from '@/lib/haptics'
import { splitQuoted } from '@/lib/quote'
import { apiConnection, authHeaders } from '@/lib/api'
import type { Reaction, ThreadStatus } from '@/lib/types'
import { colors } from '@/lib/theme'
import { useReducedMotionPreference } from '@/lib/reduced-motion'

/** The bot's words sit in the grey bubble (R-14). */
export function BotBubble({ children }: { children: ReactNode }) {
  return <View style={styles.botBubble}>{children}</View>
}

/** The person's words sit in the blue bubble (R-14); photos they sent sit above it, as in Messages. */
export function MyBubble({ text, photos, selecting, threadReferences }: { threadReferences?: boolean; text: string; photos?: ImageURISource[]; selecting?: ReactNode }) {
  const parsed = splitChatFiles(text)
  const pictures = useImageFiles(parsed.files)
  const { quoted, words } = splitQuoted(parsed.text)
  const parts = threadReferences && /\[\[(?:issue|run):|https:\/\/github\.com\//i.test(words) ? personReferenceParts(words) : null
  return (
    <View style={styles.mine}>
      <ChatFiles files={parsed.files.filter(file => !isImageFile(file))} />
      <ChatImages images={[...(photos ?? []), ...pictures]} align="right" />
      {text ? (
        <View style={[styles.myBubble, { maxWidth: '100%' }]}>
          {quoted ? <Text numberOfLines={3} style={styles.quoted}>{quoted}</Text> : null}
          {selecting ?? (words ? <FoldedWords text={words} color={colors.onAccent}>{parts?.map((part, index) => {
            if (part.kind === 'text') return part.text
            return <Text key={index} accessibilityRole="link" style={{ color: colors.onAccent, textDecorationLine: 'underline' }} onPress={() => {
              if (part.kind === 'pr') void Linking.openURL(part.id)
              else router.push(part.kind === 'task' ? `/task/${part.id}` : `/thread/${part.id}`)
            }}>{part.kind === 'pr' ? part.id : `${mobileMessages.ThreadReferences[part.kind]} ${part.id.slice(0, 8)}`}</Text>
          })}</FoldedWords> : null)}
        </View>
      ) : null}
    </View>
  )
}

/** Lines a long message keeps when folded, and the length it must pass before it folds (25pt lines, styles.body). */
const FOLD_LINES = 10
const FOLD_AFTER = 13

/**
 * A long message folded to its first lines with 显示更多 / 收起 under it, as Messages and
 * ChatGPT fold a long one. The full height is measured once from layout (works on iOS and
 * Expo Web alike); folding is the native line limit.
 */
export function FoldedWords({ text, color, children }: { text: string; color: string; children?: ReactNode }) {
  const [long, setLong] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => { setLong(false); setOpen(false) }, [text])
  return (
    <>
      <Text style={[styles.body, { color }]} numberOfLines={long && !open ? FOLD_LINES : undefined}
        onLayout={event => { if (!long && event.nativeEvent.layout.height > FOLD_AFTER * styles.body.lineHeight) setLong(true) }}>{children ?? text}</Text>
      {long ? (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} hitSlop={8} onPress={() => { tap(); setOpen(value => !value) }} style={styles.foldToggle}>
          <Text style={[styles.foldLabel, { color }]}>{open ? '收起' : '显示更多'}</Text>
        </Pressable>
      ) : null}
    </>
  )
}

/** A sent photo as the chat loads it: the person's own message, signed in. */
export function useChatPhotos(): (messageId: string | undefined, count: number | undefined) => ImageURISource[] {
  const [connection] = useState(apiConnection)
  const [headers, setHeaders] = useState<Record<string, string> | null>(null)
  useEffect(() => { void authHeaders(connection).then(setHeaders) }, [connection])
  return (messageId, count) => {
    if (!count) return []
    // Still in the inbox (no message row yet): grey stand-ins until the next poll.
    if (!messageId || !headers) return Array.from({ length: count }, () => ({ uri: '' }))
    return Array.from({ length: count }, (_, index) => ({ uri: `${connection.account.server.url}/api/mobile/chat/image?message=${messageId}&index=${index}`, headers }))
  }
}

/**
 * A pending message keeps its words and its retry action. Missing receipts say
 * 未确认; only a known server refusal says 未发送.
 */
export function OutgoingBubble({ text, photos, failed, unconfirmed = false, error, onRetry }: { text: string; photos?: string[]; failed: boolean; unconfirmed?: boolean; error?: string; onRetry?: () => void }) {
  const canRetry = failed && Boolean(onRetry)
  const reason = unconfirmed ? mobileMessages.Coordinator.sendUncertain : error ?? mobileMessages.GroupChat.notSent
  const parsed = splitChatFiles(text)
  const { quoted, words } = splitQuoted(parsed.text)
  return (
    <Pressable accessibilityRole={failed ? 'button' : undefined} accessibilityState={failed ? { disabled: !canRetry } : undefined} accessibilityHint={canRetry ? mobileMessages.Common.retry : undefined} disabled={!canRetry} onPress={onRetry} style={styles.outgoing}>
      <View style={[{ alignItems: 'flex-end', gap: 4 }, !failed && { opacity: 0.6 }]}>
        {photos?.length ? <ChatImages images={photos.map(uri => ({ uri }))} align="right" /> : null}
        {text ? (
          <View style={[styles.myBubble, { maxWidth: '100%' }]}>
            {parsed.files.map(file => <Text key={file.id} numberOfLines={1} style={[styles.body, { color: colors.onAccent }]}>{file.name}</Text>)}
            {quoted ? <Text numberOfLines={3} style={styles.quoted}>{quoted}</Text> : null}
            {words ? <Text style={[styles.body, { color: colors.onAccent }]}>{words}</Text> : null}
          </View>
        ) : null}
      </View>
      {failed ? (
        <View style={styles.retryRow}>
          <CircleAlert size={14} color={colors.danger} strokeWidth={2.2} />
          <Text style={styles.retry}>{canRetry ? `${reason} · ${mobileMessages.Common.retry}` : reason}</Text>
        </View>
      ) : null}
    </Pressable>
  )
}

/**
 * A thread card: status icon and name, outputs as chips; no step line (R-66). Opens the thread's page. A thread
 * waiting for the person carries its action (去回答, #1386); a long name is cut here and read in full on its page.
 */
export function ThreadCard({ title, status, info, onPress, action, icon, footer }: { title: string; status: ThreadStatus; info?: string | null; onPress: () => void; action?: string; icon?: ReactNode; footer?: ReactNode }) {
  const body = (
    <>
      {/* A task card (2026-11-07) passes its task state's icon; a thread without a task keeps its bubble. */}
      {icon ?? <StatusIcon status={status} size={18} />}
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
  // A code task's card carries its review summary as a second button under the card's own (#1738).
  if (footer) return (
    <View style={[styles.threadCard, styles.threadCardStack]}>
      <Pressable accessibilityRole="button" accessibilityLabel={[title, info].filter(Boolean).join('，')} onPress={onPress} style={({ pressed }) => [styles.threadOpen, pressed && { opacity: 0.6 }]}>{body}</Pressable>
      <View style={styles.threadFooter}>{footer}</View>
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

/**
 * A message row. A long press selects the message's words where they are, natively (`onSelect`; the system's
 * selection handles and its own menu), as Codex does; the bubble gives way a little while the finger rests. There is
 * no drag on a message (Alex 2026-11-08): the screen's left edge is only the system's swipe back, and reactions, 复制
 * and 回复 live in the ⋯ under the message (MessageActions). VoiceOver reaches 选择文本 on the frame over it.
 */
export function MessageRow({ children, align = 'left', onSelect }: { children: ReactNode; align?: 'left' | 'right'; onSelect?: () => void }) {
  const reduceMotion = useReducedMotionPreference()
  const held = useCallback(() => { press(); onSelect?.() }, [onSelect])
  // While a finger rests on the bubble it gives way a little (after 120 ms, so a tap or a scroll never shows it), and
  // the selection starts at 500 ms; letting go or scrolling springs it back.
  const pressed = useSharedValue(1)
  const long = Gesture.LongPress().enabled(Boolean(onSelect)).minDuration(HOLD_MS)
    .onBegin(() => { if (!reduceMotion) pressed.value = withDelay(PRESS_IN_DELAY, withTiming(PRESSED_SCALE, { duration: HOLD_MS - PRESS_IN_DELAY })) })
    .onStart(() => { scheduleOnRN(held) })
    .onFinalize(() => { pressed.value = reduceMotion ? 1 : withSpring(1, SNAP_BACK) })
  const scaled = useAnimatedStyle(() => ({ transform: [{ scale: pressed.value }] }))
  return (
    <View>
      <GestureDetector gesture={long}>
        <Reanimated.View style={[scaled, { alignItems: align === 'right' ? 'flex-end' : 'stretch' }]}>{children}</Reanimated.View>
      </GestureDetector>
      {onSelect ? (
        <Pressable accessibilityRole="button" accessibilityLabel="选择文本" focusable onPress={held}
          // No button of its own on screen: touch goes to the message (long press); VoiceOver and the keyboard reach
          // the same action on this frame over it.
          pointerEvents="none" style={StyleSheet.absoluteFill} />
      ) : null}
    </View>
  )
}

/** A press selects the words after this long (ms); the bubble starts to give way after `PRESS_IN_DELAY`. */
const HOLD_MS = 500
const PRESS_IN_DELAY = 120
const PRESSED_SCALE = 0.96

/**
 * A centred time above a group of messages (Alex 2026-11-08), as in Messages: 「09:21」, 「昨天 21:04」,
 * 「星期五 14:11」, 「11月3日 14:11」 (lib/chat-time.ts). Messages no longer carry their own times.
 */
export function TimeSeparator({ label }: { label: string }) {
  return <Text accessibilityRole="header" style={styles.separator}>{label}</Text>
}

/**
 * The row under a bot's reply, or another member's message in a group (Alex 2026-11-08): ⋯ holds its reactions,
 * 回复, 复制 and 选择文本 (MessageMenu); under the bot's latest reply 复制 sits beside it, as in ChatGPT and Claude. The
 * person's own messages have no row: a long press selects their words.
 */
export function MessageActions({ message, align = 'left', copy }: { message: HeldMessage; align?: 'left' | 'right'; copy?: boolean }) {
  return (
    <View style={[styles.replyActions, align === 'right' && styles.replyActionsRight]}>
      {copy ? <CopyButton text={message.text} /> : null}
      <MessageMenu message={message} />
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
  foldToggle: { alignSelf: 'flex-start', marginTop: 4 },
  foldLabel: { fontSize: 15, fontWeight: '600', opacity: 0.85 },
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
  threadCardStack: { flexDirection: 'column', alignItems: 'stretch', gap: 0, paddingVertical: 4 },
  threadFooter: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator, marginLeft: 30 },
  threadOpen: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
  threadTitle: { fontSize: 16, fontWeight: '500' },
  threadInfo: { fontSize: 12, lineHeight: 16, color: colors.secondary },
  event: { alignSelf: 'center', textAlign: 'center', fontSize: 12, lineHeight: 17, color: colors.secondary, marginHorizontal: 24 },
  separator: { alignSelf: 'center', textAlign: 'center', fontSize: 12, lineHeight: 16, fontWeight: '500', color: colors.secondary, marginTop: 8, marginBottom: 2, fontVariant: ['tabular-nums'] },
  // A 32-point button whose 6-point hitSlop keeps the 44-point target (the glyph at text size, as in ChatGPT and Claude).
  copy: { alignSelf: 'flex-start', width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  // The icons' own 44-point targets sit flush with the bubble's left edge, a little under it.
  replyActions: { flexDirection: 'row', alignSelf: 'flex-start', gap: 4, marginLeft: -8, marginTop: -4, marginBottom: -4 },
  replyActionsRight: { alignSelf: 'flex-end', marginLeft: 0, marginRight: -8 },
})
import { splitChatFiles } from '@mikka/protocol/chat-attachments'
import { ChatFiles } from './ChatFiles'
import { ChatImages } from '@/features/chat/components/chat-images'
import { isImageFile, useImageFiles } from '@/features/chat/model/chat-image-source'
