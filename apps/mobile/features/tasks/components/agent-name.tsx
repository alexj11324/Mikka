import { StyleSheet, View, type TextStyle } from 'react-native'
import { SvgXml } from 'react-native-svg'
import { Sparkles } from 'lucide-react-native'
import claudeCode from '@lobehub/icons-static-svg/icons/claudecode-color.svg'
import codex from '@lobehub/icons-static-svg/icons/codex-color.svg'
import cursor from '@lobehub/icons-static-svg/icons/cursor.svg'
import { Text } from '@/components/Text'
import { HARNESS } from '@/lib/harness'
import { colors } from '@/lib/theme'
import { agentMark } from '../model/agent-marks'

/** Each Agent's own coloured brand mark, as the web draws it (R-74); Cursor's monochrome mark follows the text colour. */
const MARKS: Record<string, string> = { claude_code: agentMark(claudeCode), codex: agentMark(codex), cursor: agentMark(cursor) }

/**
 * An Agent as the task names it: its brand mark, then its name (「Codex」). Used where the task's conversation changes
 * Agent and on 活动's rows; no verb, no 「换」 (Alex 2026-11-09, as Warp shows it).
 */
export function AgentName({ harness, style, size = 14 }: { harness: string; style?: TextStyle; size?: number }) {
  const mark = MARKS[harness]
  return (
    <View style={styles.row}>
      {mark ? <SvgXml xml={mark} width={size} height={size} color={colors.ink} /> : <Sparkles size={size} color={colors.secondary} strokeWidth={2} />}
      <Text style={[styles.name, style]} numberOfLines={1}>{HARNESS[harness] ?? harness}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0, flexShrink: 1 },
  name: { flexShrink: 1 },
})
