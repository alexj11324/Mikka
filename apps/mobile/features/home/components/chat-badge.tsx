import { StyleSheet, View } from 'react-native'
import { Text } from '@/components/Text'
import { colors } from '@/lib/theme'
import { badgeOf, type ListChat } from '../model/home-list'

/**
 * A chat's mark: an orange dot when one of its threads waits on the person, else the unread count, else a dot for a
 * chat marked unread by hand. On a row it sits on the right under the time; on a pinned tile (`avatar`) it sits on
 * the avatar's lower corner (Comma design 01).
 */
export function ChatBadge({ chat, avatar = false }: { chat: ListChat; avatar?: boolean }) {
  const badge = badgeOf(chat)
  if (!badge) return null
  const place = avatar ? styles.corner : null
  if (badge.kind === 'waiting') return <View style={[styles.dot, styles.waiting, place]} accessibilityLabel="等你回复" />
  if (badge.kind === 'dot') return <View style={[styles.dot, place]} accessibilityLabel="未读" />
  return (
    <View style={[styles.count, place]} accessibilityLabel={`${badge.count} 条未读`}>
      <Text style={styles.number}>{badge.count > 99 ? '99+' : badge.count}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  corner: { position: 'absolute', right: -2, bottom: -2, borderWidth: 2, borderColor: colors.page },
  dot: { width: 14, height: 14, borderRadius: 7, backgroundColor: colors.accent },
  waiting: { backgroundColor: colors.orange },
  count: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  number: { fontSize: 12.5, lineHeight: 16, fontWeight: '600', color: colors.onAccent, fontVariant: ['tabular-nums'] },
})
