import { useState } from 'react'
import { Platform, Pressable, StyleSheet, View } from 'react-native'
import Reanimated, { cubicBezier } from 'react-native-reanimated'
import { ChevronDown, ChevronUp, Clock, CornerDownRight } from 'lucide-react-native'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { tap } from '@/lib/haptics'
import { useReducedMotionPreference } from '@/lib/reduced-motion'
import { colors } from '@/lib/theme'
import type { ChatItem } from '@/lib/types'
import { queuePreview } from '@/features/chat/model/chat-queue'
import { ChatGlass } from './chat-glass-capsule'

const EASE = cubicBezier(0.23, 1, 0.32, 1)
const ROW = 44
const MORE = 36
const LINE = 36

/**
 * Messages waiting for the bot to finish (#1408 Phase 3): one glass card above the composer. Its first row is the
 * next message with 「现在发」, which stops the current reply so the queue goes next. With more waiting, a second row
 * (还有 N 条) opens the rest inside the card. The card's height moves with a 280 ms transition.
 */
export function ChatQueueCard({ items, onSendNow, busy }: { items: ChatItem[]; onSendNow?: () => void; busy: boolean }) {
  const reduceMotion = useReducedMotionPreference()
  const [open, setOpen] = useState(false)
  if (!items.length) return null
  const [next, ...rest] = items
  const expanded = open && rest.length > 0
  const height = ROW + (rest.length ? MORE : 0) + (expanded ? rest.length * LINE : 0)
  return (
    <Reanimated.View style={[styles.wrap, { height }, { transitionProperty: 'height', transitionDuration: reduceMotion ? 0 : 280, transitionTimingFunction: EASE }]}>
      <ChatGlass style={styles.card}>
        <View style={styles.row}>
          <View accessible accessibilityLabel={`排队中：${queuePreview(next!)}`} style={styles.preview}>
            <Symbol name="clock" size={14} color={colors.secondary} web={<Clock size={16} color={colors.secondary} strokeWidth={2} />} />
            <Text numberOfLines={1} style={styles.text}>{queuePreview(next!)}</Text>
          </View>
          {onSendNow ? (
            <Pressable accessibilityRole="button" accessibilityLabel="现在发" accessibilityHint="停止当前回复，先处理排队的消息" accessibilityState={{ disabled: busy, busy }}
              aria-disabled={Platform.OS === 'web' ? busy : undefined} disabled={busy} hitSlop={4} onPress={() => { tap(); onSendNow() }}
              style={({ pressed }) => [styles.action, busy && { opacity: 0.45 }, pressed && { opacity: 0.55 }]}>
              <Symbol name="arrow.turn.down.right" size={15} color={colors.ink} web={<CornerDownRight size={18} color={colors.ink} strokeWidth={2} />} />
              <Text style={styles.actionLabel}>现在发</Text>
            </Pressable>
          ) : null}
        </View>
        {rest.length ? (
          <Pressable accessibilityRole="button" accessibilityLabel={open ? '收起排队消息' : `还有 ${rest.length} 条排队消息`} accessibilityState={{ expanded }}
            onPress={() => { tap(); setOpen(value => !value) }} style={({ pressed }) => [styles.more, pressed && { opacity: 0.55 }]}>
            <Text style={styles.moreText}>{open ? '收起' : `还有 ${rest.length} 条`}</Text>
            {open
              ? <Symbol name="chevron.down" size={11} color={colors.secondary} web={<ChevronDown size={14} color={colors.secondary} strokeWidth={2.4} />} />
              : <Symbol name="chevron.up" size={11} color={colors.secondary} web={<ChevronUp size={14} color={colors.secondary} strokeWidth={2.4} />} />}
          </Pressable>
        ) : null}
        {rest.map((item, index) => (
          <View key={`${item.position}`} accessible accessibilityLabel={`第 ${index + 2} 条：${queuePreview(item)}`} style={styles.line}>
            <Text style={styles.position}>{index + 2}</Text>
            <Text numberOfLines={1} style={styles.text}>{queuePreview(item)}</Text>
          </View>
        ))}
      </ChatGlass>
    </Reanimated.View>
  )
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden', borderRadius: 22 },
  card: { borderRadius: 22, minHeight: '100%' },
  row: { height: ROW, flexDirection: 'row', alignItems: 'center', paddingLeft: 14, paddingRight: 6, gap: 6 },
  preview: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
  text: { flex: 1, minWidth: 0, fontSize: 15, lineHeight: 20, color: colors.text },
  action: { minHeight: 44, minWidth: 44, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  actionLabel: { fontSize: 14, fontWeight: '600', color: colors.ink },
  more: { height: MORE, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator },
  moreText: { fontSize: 12, fontWeight: '600', color: colors.secondary },
  line: { height: LINE, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14 },
  position: { width: 22, height: 22, borderRadius: 11, overflow: 'hidden', textAlign: 'center', lineHeight: 22, fontSize: 12, fontWeight: '600', color: colors.secondary, backgroundColor: colors.bubble },
})
