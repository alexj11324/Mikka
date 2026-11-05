import { StyleSheet, View } from 'react-native'
import { Text } from '@/components/Text'
import { colors } from '@/lib/theme'
import { badgeOf, type ListChat } from '../model/home-list'

/**
 * The mark on a chat avatar's corner: an orange waiting mark when one of its threads waits on the person, else the
 * unread count, else a dot for a chat marked unread by hand.
 */
export function ChatBadge({ chat }: { chat: ListChat }) {
  const badge = badgeOf(chat)
  if (!badge) return null
  if (badge.kind === 'waiting') return <View style={[styles.badge, styles.waiting]} accessibilityLabel="等你回复"><Text style={styles.mark}>?</Text></View>
  if (badge.kind === 'dot') return <View style={[styles.badge, styles.dot]} accessibilityLabel="未读" />
  return (
    <View style={[styles.badge, styles.count]} accessibilityLabel={`${badge.count} 条未读`}>
      <Text style={styles.number}>{badge.count > 99 ? '99+' : badge.count}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  badge: { position: 'absolute', right: -3, top: -3, borderWidth: 2, borderColor: colors.page, alignItems: 'center', justifyContent: 'center' },
  waiting: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.orange },
  mark: { fontSize: 12, lineHeight: 15, fontWeight: '700', color: colors.onAccent },
  dot: { width: 16, height: 16, borderRadius: 8, backgroundColor: colors.accent },
  count: { minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 5, backgroundColor: colors.accent },
  number: { fontSize: 12, lineHeight: 15, fontWeight: '600', color: colors.onAccent, fontVariant: ['tabular-nums'] },
})
