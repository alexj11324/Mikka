import { Pressable, StyleSheet } from 'react-native'
import { BotAvatar, Spinner } from '@/components/icons'
import { Text } from '@/components/Text'
import { colors } from '@/lib/theme'
import { ChatGlass } from './chat-glass-capsule'

/**
 * The chat's title (Alex 2026-11-08, after Grok's header): the bot's avatar and its name in one frosted-glass pill,
 * centred in the bar, so the messages scrolling under the bar never show through the name. The same glass as the
 * chat's other floating controls (ChatGlass); a solid lifted pill under Reduce Transparency and before iOS 26. A tap
 * opens the bot's page. The avatar is the slot's (slots/bot-avatar.tsx), which the hosted layer animates.
 */
export function ChatTitlePill({ name, color, shape, botId, coordinator, onPress }: {
  name: string; color?: string; shape?: string; botId?: string; coordinator?: boolean; onPress: () => void
}) {
  if (!name) return <Spinner size={14} />
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${name}，资料`} hitSlop={4} onPress={onPress} style={({ pressed }) => pressed && { opacity: 0.7 }}>
      <ChatGlass interactive style={styles.pill}>
        <BotAvatar color={color} shape={shape} id={botId} coordinator={coordinator} size={26} />
        <Text style={styles.name} numberOfLines={1}>{name}</Text>
      </ChatGlass>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 40, maxWidth: 240, paddingLeft: 7, paddingRight: 14, borderRadius: 20 },
  name: { flexShrink: 1, fontSize: 16, fontWeight: '600', color: colors.ink },
})
