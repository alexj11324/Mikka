import { StyleSheet, View } from 'react-native'
import { Text } from '@/components/Text'
import { GlassButton } from '@/components/GlassButton'
import { colors } from '@/lib/theme'
import { mobileMessages } from '@/lib/messages'

/** 「停止未确认 · 重试」 under a reply or thread that a stop did not end (lib/useStop.ts). */
export function StopFailed({ onRetry, busy }: { onRetry: () => void; busy: boolean }) {
  return (
    <View style={styles.row} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <Text style={styles.text}>{mobileMessages.MobileCore.stopUnconfirmed}</Text>
      <GlassButton label={mobileMessages.Common.retry} busy={busy} onPress={onRetry} />
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', alignSelf: 'center', gap: 10 },
  text: { fontSize: 13, color: colors.danger },
})
