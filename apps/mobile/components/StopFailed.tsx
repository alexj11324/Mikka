import { StyleSheet, View } from 'react-native'
import { CardButton } from '@/components/cards'
import { Text } from '@/components/Text'
import { colors } from '@/lib/theme'

/** 「没停下 · 重试」 under a reply or thread that a stop did not end (lib/useStop.ts). */
export function StopFailed({ onRetry, busy }: { onRetry: () => void; busy: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.text}>没停下</Text>
      <CardButton label="重试" busy={busy} onPress={onRetry} />
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', alignSelf: 'center', gap: 10 },
  text: { fontSize: 13, color: colors.danger },
})
