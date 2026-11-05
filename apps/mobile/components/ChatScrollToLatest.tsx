import { Pressable, StyleSheet } from 'react-native'
import { Text } from '@/components/Text'
import { colors } from '@/lib/theme'

export function ChatScrollToLatest({ visible, bottom, onPress }: { visible: boolean; bottom: number; onPress: () => void }) {
  if (!visible) return null
  return <Pressable accessibilityRole="button" accessibilityLabel="回到最新消息" onPress={onPress} style={[styles.button, { bottom }]}>
    <Text style={styles.label}>回到最新</Text>
  </Pressable>
}
const styles = StyleSheet.create({
  button: { position: 'absolute', right: 20, minHeight: 44, paddingHorizontal: 16, justifyContent: 'center', borderRadius: 22, backgroundColor: colors.bubble },
  label: { fontSize: 14, color: colors.text },
})
