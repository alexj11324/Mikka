import { Pressable, StyleSheet, View } from 'react-native'
import { ChevronDown, ChevronRight } from 'lucide-react-native'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { colors } from '@/lib/theme'
import type { HomeItem } from '../model/home-list'

/** A section's header: its name and count, and a chevron that folds it; a folded section shows its unread count. */
export function SectionHeader({ section, onToggle }: { section: Extract<HomeItem<unknown>, { kind: 'section' }>; onToggle: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: !section.collapsed }} accessibilityLabel={`${section.title}，${section.count}`}
      onPress={onToggle} style={({ pressed }) => [styles.header, pressed && { opacity: 0.6 }]}>
      <Text style={styles.title}>{section.title}</Text>
      <Text style={styles.count}>{section.count}</Text>
      <Symbol name={section.collapsed ? 'chevron.right' : 'chevron.down'} size={11} color={colors.tertiary}
        web={section.collapsed ? <ChevronRight size={14} color={colors.tertiary} strokeWidth={2.4} /> : <ChevronDown size={14} color={colors.tertiary} strokeWidth={2.4} />} />
      <View style={styles.fill} />
      {section.collapsed && section.unread > 0 ? (
        <View style={styles.unread} accessibilityLabel={`${section.unread} 条未读`}><Text style={styles.unreadText}>{section.unread > 99 ? '99+' : section.unread}</Text></View>
      ) : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  header: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 20, paddingRight: 16, paddingTop: 10, paddingBottom: 2 },
  title: { fontSize: 13, lineHeight: 18, fontWeight: '500', color: colors.secondary },
  count: { fontSize: 13, lineHeight: 18, color: colors.tertiary },
  fill: { flex: 1 },
  unread: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  unreadText: { fontSize: 12.5, lineHeight: 16, fontWeight: '600', color: colors.onAccent },
})
