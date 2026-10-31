import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Animated, Image, PanResponder, Pressable, StyleSheet, View, type ImageURISource } from 'react-native'
import { CircleAlert } from 'lucide-react-native'
import { StatusIcon } from '@/components/icons'
import { Text } from '@/components/Text'
import { authHeaders } from '@/lib/api'
import { API_URL } from '@/lib/config'
import type { ThreadStatus } from '@/lib/types'
import { colors } from '@/lib/theme'

/** The bot's words sit in the grey bubble (R-14). */
export function BotBubble({ children }: { children: ReactNode }) {
  return <View style={styles.botBubble}>{children}</View>
}

/** The person's words sit in the blue bubble (R-14); photos they sent sit above it, as in Messages. */
export function MyBubble({ text, photos }: { text: string; photos?: ImageURISource[] }) {
  return (
    <View style={styles.mine}>
      {photos?.length ? <Photos photos={photos} /> : null}
      {text ? (
        <View style={[styles.myBubble, { maxWidth: '100%' }]}>
          <Text style={[styles.body, { color: '#fff' }]}>{text}</Text>
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
  mine: { alignSelf: 'flex-end', alignItems: 'flex-end', maxWidth: '78%', gap: 4 },
  photos: { alignItems: 'flex-end', gap: 4 },
  photo: { width: 160, borderRadius: 18, backgroundColor: colors.bubble },
  outgoing: { alignSelf: 'flex-end', alignItems: 'flex-end', maxWidth: '78%', gap: 4 },
  retryRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  retry: { fontSize: 12, color: colors.danger },
  threadCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.bubble, borderRadius: 18, paddingHorizontal: 16, height: 52 },
  threadTitle: { flex: 1, fontSize: 16, fontWeight: '500' },
  event: { alignSelf: 'center', textAlign: 'center', fontSize: 12, lineHeight: 17, color: colors.secondary, marginHorizontal: 24 },
  time: { position: 'absolute', right: -REVEAL + 6, bottom: 4, fontSize: 11, color: colors.tertiary },
})
