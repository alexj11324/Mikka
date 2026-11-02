import { Pressable, StyleSheet, View } from 'react-native'
import { Text } from '@/components/Text'
import type { ModelMenuState } from '@/lib/model-menu'
import { colors } from '@/lib/theme'

/** Above the composer: which pick did not save and why, with 重试 (Figma 843:2 #3). */
export function ModelNotice({ model }: { model: ModelMenuState }) {
  const { failure, choose } = model
  if (!failure) return null
  return (
    <View style={styles.notice}>
      <Text style={styles.line} numberOfLines={2}>{failure.line}</Text>
      <Pressable accessibilityRole="button" hitSlop={8} onPress={() => void choose(failure.id)}>
        <Text style={styles.retry}>重试</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  notice: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, marginBottom: 8 },
  line: { flexShrink: 1, fontSize: 13, lineHeight: 18, color: colors.danger },
  retry: { fontSize: 13, lineHeight: 18, color: colors.accent },
})
