import { StyleSheet, View } from 'react-native'
import { Text } from '@/components/Text'
import { colors } from '@/lib/theme'
import { avatarBadge, formatUnread, waitingGlyph, waitingLabel, type WaitingMark } from '../model/chat-badge'

/** The corner mark on a chat avatar: a waiting mark, or else the unread count. */
export function AvatarBadge({ waiting, unread }: { waiting: WaitingMark | null; unread: number }) {
  const badge = avatarBadge({ waiting, unread })
  if (!badge) return null
  if (badge.kind === 'waiting') {
    return (
      <View accessibilityLabel={waitingLabel(badge.mark)} style={[styles.badge, styles.waiting]}>
        <Text style={styles.glyph}>{waitingGlyph(badge.mark)}</Text>
      </View>
    )
  }
  return (
    <View accessibilityLabel={`未读 ${formatUnread(badge.count)}`} style={[styles.badge, styles.unread]}>
      <Text style={styles.count}>{formatUnread(badge.count)}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  badge: {
    position: 'absolute', top: -4, right: -4, minWidth: 18, height: 18, paddingHorizontal: 4,
    borderRadius: 9, borderWidth: 2, borderColor: colors.page, alignItems: 'center', justifyContent: 'center',
  },
  unread: { backgroundColor: colors.unread },
  waiting: { backgroundColor: colors.orange },
  count: { color: colors.onAccent, fontSize: 11, lineHeight: 14, fontWeight: '600' },
  glyph: { color: colors.onAccent, fontSize: 10, lineHeight: 13, fontWeight: '700' },
})
