import { Pressable, StyleSheet, View } from 'react-native'
import { Text } from '@/components/Text'
import { tap } from '@/lib/haptics'
import { colors } from '@/lib/theme'

/** How many rows a closed section (已解决, 已完成) shows before 显示全部. */
export const CLOSED_SHOWN = 5

/** A list section's header, as on the home list: its name in small grey type and how many rows it has. */
export function ListSectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <View style={styles.header}>
      <Text accessibilityRole="header" style={styles.title}>{title}</Text>
      {count !== undefined ? <Text style={styles.count}>{count}</Text> : null}
    </View>
  )
}

/** Under a closed section cut to its first rows: shows the rest. */
export function ShowAllRow({ count, onPress }: { count: number; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={() => { tap(); onPress() }} hitSlop={6} style={({ pressed }) => [styles.all, pressed && { opacity: 0.6 }]}>
      <Text style={styles.allText}>显示全部 {count} 个</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 20, paddingTop: 14, paddingBottom: 6 },
  title: { fontSize: 13, lineHeight: 18, fontWeight: '500', color: colors.secondary },
  count: { fontSize: 13, lineHeight: 18, color: colors.tertiary },
  all: { alignSelf: 'flex-start', paddingHorizontal: 20, paddingVertical: 8 },
  allText: { fontSize: 14, lineHeight: 19, fontWeight: '500', color: colors.accent },
})
