import { Pressable, StyleSheet } from 'react-native'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { colors } from '@/lib/theme'
import { formatUnread } from '../model/chat-badge'

/** A section of the home list. A tap folds it; folded, the number is how many inside are unread. */
export function SectionHeader({ title, count, unread, collapsed, onPress }: {
  title: string
  count: number
  unread: number
  collapsed: boolean
  onPress: () => void
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: !collapsed }} accessibilityLabel={collapsed ? `展开${title}` : `收起${title}`}
      onPress={onPress} style={({ pressed }) => [styles.section, pressed && { opacity: 0.6 }]}>
      <Symbol name={collapsed ? 'chevron.right' : 'chevron.down'} size={12} color={colors.secondary}
        web={<Text style={styles.chevron}>{collapsed ? '›' : '⌄'}</Text>} />
      <Text accessibilityRole="header" style={styles.title}>{title}</Text>
      {collapsed ? (unread > 0 ? <Text style={styles.count}>{formatUnread(unread)}</Text> : null) : <Text style={styles.count}>{String(count)}</Text>}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  section: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 20, paddingRight: 16, paddingTop: 14, paddingBottom: 4, minHeight: 36 },
  chevron: { fontSize: 14, lineHeight: 18, color: colors.secondary },
  title: { fontSize: 13, lineHeight: 18, fontWeight: '500', color: colors.secondary },
  count: { fontSize: 13, lineHeight: 18, color: colors.tertiary },
})
