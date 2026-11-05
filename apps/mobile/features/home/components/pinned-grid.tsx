import { Pressable, StyleSheet, View } from 'react-native'
import { GestureDetector } from 'react-native-gesture-handler'
import { BotAvatar } from '@/components/icons'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { colors } from '@/lib/theme'
import type { HomeChat, useHomeChats } from '../model/use-home-chats'
import { ChatBadge } from './chat-badge'
import { useChatDrag } from './chat-drag'
import { ChatLink } from './chat-link'

type Actions = ReturnType<typeof useHomeChats>

/** The pinned chats above the list: a grid of four columns, each tile with the row's link, preview, menu and drag. */
export function PinnedGrid({ pinned, actions }: { pinned: HomeChat[]; actions: Actions }) {
  if (!pinned.length) return null
  return <View style={styles.grid}>{pinned.map(chat => <PinnedTile key={chat.key} chat={chat} actions={actions} />)}</View>
}

function PinnedTile({ chat, actions }: { chat: HomeChat; actions: Actions }) {
  const drag = useChatDrag(chat.key, 'pins')
  const name = chat.row.kind === 'bot' ? chat.row.bot.name : chat.row.group.title
  return (
    <GestureDetector gesture={drag.gesture}>
      <View ref={drag.ref} collapsable={false} style={styles.cell}>
        <ChatLink chat={chat} actions={actions} ignore={drag.active} accessibilityLabel={name} style={({ pressed }) => [styles.tile, pressed && { opacity: 0.6 }]}>
          <View style={styles.tileInner}>
            <View>
              {chat.row.kind === 'bot' ? <BotAvatar color={chat.row.bot.color} shape={chat.row.bot.shape} size={64} />
                : <View style={styles.group}><Symbol name="person.2.fill" size={26} color={colors.secondary} web={<Text style={styles.glyph}>群</Text>} /></View>}
              <ChatBadge chat={chat} />
            </View>
            <Text style={styles.name} numberOfLines={1}>{name}</Text>
          </View>
        </ChatLink>
      </View>
    </GestureDetector>
  )
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 8, paddingTop: 12, paddingBottom: 8, rowGap: 16 },
  cell: { width: '25%' },
  tile: { paddingHorizontal: 4 },
  tileInner: { alignItems: 'center', gap: 8 },
  group: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.bubble, alignItems: 'center', justifyContent: 'center' },
  glyph: { fontSize: 20, color: colors.secondary },
  name: { fontSize: 12.5, lineHeight: 16, textAlign: 'center' },
})
