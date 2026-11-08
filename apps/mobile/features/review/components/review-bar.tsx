import { Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { MessageSquare } from 'lucide-react-native'
import { Spinner } from '@/components/icons'
import { Text } from '@/components/Text'
import { colors, LIST_INSET, lift } from '@/lib/theme'

/**
 * The floating batch bar on R2 and R3: 「2 条评论 · ios-unit 失败」 (or 写修改意见… when nothing is in the batch) and
 * 发给 Agent in the accent colour, the one submit (decisions/2026-11-08-1230 4). The words open the batch to edit it and
 * write a note. A teammate sees why it is off.
 */
export function ReviewBar({ line, onOpen, onSend, canSend, blocked, busy }: {
  line: string | null; onOpen: () => void; onSend: () => void; canSend: boolean; blocked?: string; busy?: boolean
}) {
  const insets = useSafeAreaInsets()
  return (
    <View pointerEvents="box-none" style={[styles.wrap, { bottom: insets.bottom + 8 }]}>
      <View style={styles.bar}>
        <Pressable accessibilityRole="button" accessibilityLabel={line ? `待发送：${line}` : '写修改意见'} onPress={onOpen} disabled={Boolean(blocked)}
          style={({ pressed }) => [styles.words, pressed && { opacity: 0.6 }]}>
          <MessageSquare size={18} color={colors.secondary} strokeWidth={2} />
          <Text style={[styles.line, (!line || blocked) && { color: colors.secondary }, blocked && styles.blocked]} numberOfLines={blocked ? 2 : 1}>{blocked ?? line ?? '写修改意见…'}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="发给 Agent" accessibilityState={{ disabled: !canSend || busy, busy }} disabled={!canSend || busy} onPress={onSend}
          style={({ pressed }) => [styles.send, (!canSend || busy) && { opacity: 0.4 }, pressed && { opacity: 0.8 }]}>
          {busy ? <Spinner size={14} color={colors.onAccent} /> : null}
          <Text style={styles.sendText}>发给 Agent</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: LIST_INSET, right: LIST_INSET },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 56, paddingLeft: 16, paddingRight: 8, borderRadius: 28, borderCurve: 'continuous', backgroundColor: colors.surface, ...lift },
  words: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  line: { flex: 1, fontSize: 16, color: colors.text },
  blocked: { fontSize: 14, lineHeight: 18 },
  send: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 40, paddingHorizontal: 16, borderRadius: 20, backgroundColor: colors.accentFill },
  sendText: { fontSize: 16, fontWeight: '600', color: colors.onAccent },
})
