import { type ReactNode, useRef } from 'react'
import { Animated, PanResponder, Pressable, StyleSheet, View } from 'react-native'
import { Check } from 'lucide-react-native'
import { SourceIcon, StatusIcon } from '@/components/icons'
import { Text } from '@/components/Text'
import type { Source, ThreadStatus } from '@/lib/mock'
import { colors } from '@/lib/theme'

export type Part = string | { mention: string; source: Source; href?: string }

export type Message =
  | { id: string; kind: 'label'; text: string }
  | { id: string; kind: 'bot'; parts: Part[][]; time: string; bold?: string }
  | { id: string; kind: 'me'; text: string; time: string }
  | { id: string; kind: 'card'; time: string; source?: Source; from?: string; heading?: string; body: Part[][]; question: string; actions: string[]; answer?: string; answerNote?: string }
  | { id: string; kind: 'thread'; time: string; threadId: string; title: string; status: ThreadStatus; outputs?: string[] }

/** A mention chip inside a sentence: the app's icon and the item's name; tapping opens the item (R-41). */
export function Mention({ source, label, onPress }: { source: Source; label: string; onPress?: () => void }) {
  return (
    <Pressable accessibilityRole="link" onPress={onPress} style={styles.mention}>
      <SourceIcon source={source} size={15} />
      <Text style={styles.mentionText}>{label}</Text>
    </Pressable>
  )
}

/** Paragraphs of text and mention chips. */
export function Rich({ paragraphs, onMention }: { paragraphs: Part[][]; onMention?: (part: Exclude<Part, string>) => void }) {
  return (
    <View style={{ gap: 8 }}>
      {paragraphs.map((parts, i) => (
        <Text key={i} style={styles.body}>
          {parts.map((part, j) => typeof part === 'string'
            ? <Text key={j} style={styles.body}>{part}</Text>
            : <View key={j} style={styles.mentionWrap}><Mention source={part.source} label={part.mention} onPress={() => onMention?.(part)} /></View>)}
        </Text>
      ))}
    </View>
  )
}

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

/**
 * A proactive message: what happens if nothing is done and by when, the
 * source, and buttons for the next step (mobile.md). Once answered it keeps
 * the choice as one grey line.
 */
export function ProactiveCard({ message, onAction, onMention }: { message: Extract<Message, { kind: 'card' }>; onAction: (action: string) => void; onMention?: (part: Exclude<Part, string>) => void }) {
  const [primary, ...rest] = message.actions
  return (
    <View style={styles.card}>
      {message.source ? (
        <View style={styles.cardSource}>
          <SourceIcon source={message.source} size={15} />
          <Text style={styles.cardSourceText} numberOfLines={1}>{message.from}</Text>
        </View>
      ) : message.heading ? <Text style={[styles.cardSourceText, { marginBottom: 8 }]}>{message.heading}</Text> : null}
      <Rich paragraphs={message.body} onMention={onMention} />
      <Text style={[styles.body, styles.question]}>{message.question}</Text>
      {message.answer ? (
        <View style={styles.answered}>
          <Check size={14} color={colors.secondary} strokeWidth={2.2} />
          <Text style={styles.answeredText}>你选了「{message.answer}」{message.answerNote ? ` · ${message.answerNote}` : ''}</Text>
        </View>
      ) : (
        <View style={{ gap: 8, marginTop: 12 }}>
          <Pressable accessibilityRole="button" onPress={() => onAction(primary)} style={({ pressed }) => [styles.primary, pressed && { opacity: 0.85 }]}>
            <Text style={styles.primaryText}>{primary}</Text>
          </Pressable>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {rest.map(action => (
              <Pressable key={action} accessibilityRole="button" onPress={() => onAction(action)} style={({ pressed }) => [styles.secondary, pressed && { backgroundColor: colors.pressed }]}>
                <Text style={styles.secondaryText}>{action}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}
    </View>
  )
}

/** A thread card: status icon and name, outputs as chips; no step line (R-66). Opens the thread's page. */
export function ThreadCard({ message, onPress }: { message: Extract<Message, { kind: 'thread' }>; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.threadCard, pressed && { backgroundColor: colors.pressed }]}>
      <StatusIcon status={message.status} size={20} />
      <Text style={styles.threadTitle} numberOfLines={1}>{message.title}</Text>
    </Pressable>
  )
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
  mentionWrap: { transform: [{ translateY: 5 }] },
  mention: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: colors.chip, borderRadius: 8, paddingHorizontal: 7, height: 26, marginHorizontal: 2 },
  mentionText: { fontSize: 15 },
  botBubble: { alignSelf: 'flex-start', maxWidth: '86%', backgroundColor: colors.bubble, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 11 },
  myBubble: { alignSelf: 'flex-end', maxWidth: '78%', backgroundColor: colors.accent, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10 },
  card: { backgroundColor: colors.bubble, borderRadius: 20, padding: 14 },
  cardSource: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  cardSourceText: { fontSize: 13, color: colors.secondary },
  question: { fontWeight: '600', marginTop: 10 },
  answered: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  answeredText: { fontSize: 13, color: colors.secondary },
  primary: { height: 46, borderRadius: 14, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  secondary: { flex: 1, height: 46, borderRadius: 14, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  secondaryText: { fontSize: 16, fontWeight: '500' },
  threadCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.bubble, borderRadius: 18, paddingHorizontal: 16, height: 52 },
  threadTitle: { flex: 1, fontSize: 16, fontWeight: '500' },
  dateLabel: { alignSelf: 'center', fontSize: 12, color: colors.secondary, marginVertical: 4 },
  time: { position: 'absolute', right: -REVEAL + 6, bottom: 4, fontSize: 11, color: colors.tertiary },
})
