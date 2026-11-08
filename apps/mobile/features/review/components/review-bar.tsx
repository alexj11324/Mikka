import { Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronRight, MessageSquare } from 'lucide-react-native'
import { Spinner } from '@/components/icons'
import { Text } from '@/components/Text'
import { colors, LIST_INSET, lift } from '@/lib/theme'

/**
 * The floating batch bar on R2 and R3 (decisions/2026-11-08-1230 4). With something in the batch, 「2 条评论 · ios-unit
 * 失败 ›」 sits on top and opens the pending batch; the row below always keeps 「写修改意见…」 (or the note written so
 * far), which opens R2b, and 发给 Agent in the accent colour, the one submit. A teammate sees why it is off. Disabled,
 * 发给 Agent is an outline at reduced opacity like 批准合并, never a grey fill.
 */
export function ReviewBar({ line, note, onOpenBatch, onOpenNote, onSend, canSend, blocked, busy }: {
  line: string | null; note?: string; onOpenBatch: () => void; onOpenNote: () => void; onSend: () => void; canSend: boolean; blocked?: string; busy?: boolean
}) {
  const insets = useSafeAreaInsets()
  const off = !canSend || Boolean(busy)
  const written = note?.trim()
  return (
    <View pointerEvents="box-none" style={[styles.wrap, { bottom: insets.bottom + 8 }]}>
      <View style={styles.bar}>
        {line && !blocked ? (
          <Pressable accessibilityRole="button" accessibilityLabel={`待发送：${line}`} onPress={onOpenBatch} style={({ pressed }) => [styles.batch, pressed && { opacity: 0.6 }]}>
            <Text style={styles.batchText} numberOfLines={1}>{line}</Text>
            <ChevronRight size={16} color={colors.tertiary} strokeWidth={2} />
          </Pressable>
        ) : null}
        <View style={styles.row}>
          <Pressable accessibilityRole="button" accessibilityLabel={blocked || (written ? `修改意见：${written}` : '写修改意见')} onPress={onOpenNote} disabled={Boolean(blocked)}
            style={({ pressed }) => [styles.words, pressed && { opacity: 0.6 }]}>
            <MessageSquare size={18} color={colors.secondary} strokeWidth={2} />
            <Text style={[styles.note, !written && { color: colors.secondary }, blocked && styles.blocked]} numberOfLines={blocked ? 2 : 1}>{blocked || written || '写修改意见…'}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="发给 Agent" accessibilityState={{ disabled: off, busy }} disabled={off} onPress={onSend}
            style={({ pressed }) => [styles.send, off && !busy ? styles.sendOff : null, busy && { opacity: 0.6 }, pressed && { opacity: 0.8 }]}>
            {busy ? <Spinner size={14} color={colors.onAccent} /> : null}
            <Text style={[styles.sendText, off && !busy ? { color: colors.ink } : null]}>发给 Agent</Text>
          </Pressable>
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: LIST_INSET, right: LIST_INSET },
  bar: { paddingVertical: 8, paddingLeft: 16, paddingRight: 8, borderRadius: 28, borderCurve: 'continuous', backgroundColor: colors.surface, ...lift },
  batch: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 36, paddingRight: 8 },
  batchText: { flex: 1, fontSize: 15, fontWeight: '600', color: colors.text },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  words: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  note: { flex: 1, fontSize: 16, color: colors.text },
  blocked: { fontSize: 14, lineHeight: 18 },
  send: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 40, paddingHorizontal: 16, borderRadius: 20, backgroundColor: colors.accentFill },
  sendOff: { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: colors.ink, opacity: 0.35 },
  sendText: { fontSize: 16, fontWeight: '600', color: colors.onAccent },
})
