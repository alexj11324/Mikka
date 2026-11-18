import { StyleSheet, View } from 'react-native'
import { Text } from '@/components/Text'
import { colors, GROUP_INSET, LIST_INSET } from '@/lib/theme'

/** A list section's header, as on the home list (Comma designs 01, 13, 15): its name in grey semibold, and a count when given. */
/** `grouped` lines it up with the text of an inset grouped list's rows (插件). */
export function ListSectionHeader({ title, count, grouped = false }: { title: string; count?: number; grouped?: boolean }) {
  return (
    <View style={[styles.header, grouped && styles.groupedHeader]}>
      <Text accessibilityRole="header" style={styles.title}>{title}</Text>
      {count !== undefined ? <Text style={styles.count}>{count}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: LIST_INSET, paddingTop: 14, paddingBottom: 4 },
  groupedHeader: { paddingHorizontal: GROUP_INSET + 16, paddingTop: 18, paddingBottom: 6 },
  title: { fontSize: 15, lineHeight: 20, fontWeight: '600', color: colors.secondary },
  count: { fontSize: 15, lineHeight: 20, color: colors.tertiary },
})
