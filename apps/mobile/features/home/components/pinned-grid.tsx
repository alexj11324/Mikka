import { StyleSheet, View } from 'react-native'
import { Star } from 'lucide-react-native'
import { BotAvatar } from '@/components/icons'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { colors } from '@/lib/theme'
import type { HomeChat, useHomeChats } from '../model/use-home-chats'
import { ChatBadge } from './chat-badge'
import { ChatLink } from './chat-link'

type Actions = ReturnType<typeof useHomeChats>

/**
 * The pinned chats above the list: a grid of three columns (Comma design 01), each tile with the row's link, preview,
 * and menu; tiles are not dragged (Alex 2026-11-07). An orange star on the upper corner marks the pin; the chat's mark sits on the lower corner.
 */
export function PinnedGrid({ pinned, actions }: { pinned: HomeChat[]; actions: Actions }) {
  if (!pinned.length) return null
  return <View style={styles.grid}>{pinned.map(chat => <PinnedTile key={chat.key} chat={chat} actions={actions} />)}</View>
}

function PinnedTile({ chat, actions }: { chat: HomeChat; actions: Actions }) {
  const name = chat.row.kind === 'bot' ? chat.row.bot.name : chat.row.group.title
  return (
    <View style={styles.cell}>
      <ChatLink chat={chat} actions={actions} accessibilityLabel={name} style={({ pressed }) => [styles.tile, pressed && { opacity: 0.6 }]}>
        <View style={styles.tileInner}>
          <View>
            {chat.row.kind === 'bot' ? <BotAvatar id={chat.row.bot.id} coordinator={chat.row.bot.coordinator} color={chat.row.bot.color} shape={chat.row.bot.shape} size={64} />
              : <View style={styles.group}><Symbol name="person.2.fill" size={26} color={colors.secondary} web={<Text style={styles.glyph}>群</Text>} /></View>}
            <View style={styles.star} accessibilityElementsHidden importantForAccessibility="no">
              <Symbol name="star.fill" size={14} color={colors.orange} web={<Star size={14} color={colors.orange} fill={colors.orange} strokeWidth={0} />} />
            </View>
            <ChatBadge chat={chat} avatar />
          </View>
          <Text style={styles.name} numberOfLines={1}>{name}</Text>
        </View>
      </ChatLink>
    </View>
  )
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 12, paddingTop: 8, paddingBottom: 8, rowGap: 16 },
  star: { position: 'absolute', right: -6, top: -4 },
  cell: { width: '33.333%' },
  tile: { paddingHorizontal: 4 },
  tileInner: { alignItems: 'center', gap: 8 },
  group: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.bubble, alignItems: 'center', justifyContent: 'center' },
  glyph: { fontSize: 20, color: colors.secondary },
  name: { fontSize: 13, lineHeight: 17, textAlign: 'center' },
})
