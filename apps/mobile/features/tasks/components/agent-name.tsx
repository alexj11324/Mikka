import { StyleSheet, View, type TextStyle } from 'react-native'
import { Sparkles } from 'lucide-react-native'
import { Text } from '@/components/Text'
import { HARNESS } from '@/lib/harness'
import { colors } from '@/lib/theme'

/**
 * An Agent as the task names it: the Agent glyph the task page's Agent chip draws, then its name (「Codex」). Used where
 * the task's conversation changes Agent and on 活动's rows; no verb, no 「换」 (Alex 2026-11-09, as Warp shows it).
 */
export function AgentName({ harness, style, size = 14 }: { harness: string; style?: TextStyle; size?: number }) {
  return (
    <View style={styles.row}>
      <Sparkles size={size} color={colors.secondary} strokeWidth={2} />
      <Text style={[styles.name, style]} numberOfLines={1}>{HARNESS[harness] ?? harness}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0, flexShrink: 1 },
  name: { flexShrink: 1 },
})
