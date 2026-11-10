import { View } from 'react-native'
import { CardButton } from '@/components/cards'
import { Text } from '@/components/Text'
import { useSettings } from '@/lib/settings'
import { colors } from '@/lib/theme'

const names: Record<string, string> = { privateByDefault: '默认创建为私人', proactive: '主动消息', pushDecide: '需要你决策', pushFinished: '线程完成', pushBriefing: '每日简报', memoryEnabled: '使用记忆' }

/** Pending intention is separate from the switches' last confirmed values. */
export function PreferenceSaveNotice() {
  const { preferenceSave, retryPreferences } = useSettings()
  if (preferenceSave.status === 'idle') return null
  const saving = preferenceSave.status === 'saving'
  return <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ gap: 8, marginTop: 12, marginBottom: 16 }}>
    {Object.entries(preferenceSave.intent).map(([key, value]) => <Text key={key} style={{ fontSize: 13, color: saving ? colors.secondary : colors.danger }}>
      {`${names[key] ?? key} · ${saving ? value ? '正在开启' : '正在关闭' : value ? '开启未确认' : '关闭未确认'}`}
    </Text>)}
    {!saving ? <CardButton label="重试保存" onPress={() => void retryPreferences()} /> : null}
  </View>
}
