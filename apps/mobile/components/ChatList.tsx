import { Pressable, StyleSheet, View } from 'react-native'
import { BotAvatar, Spinner } from '@/components/icons'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { shortWhen } from '@/lib/clock'
import { useHome } from '@/lib/home'
import type { GroupSummary, HomeBot } from '@/lib/types'
import { useApi } from '@/lib/useApi'
import { colors } from '@/lib/theme'

export type ChatRow = { kind: 'bot'; bot: HomeBot; at: string } | { kind: 'group'; group: GroupSummary; at: string }

/** The person's bots and group chats, newest first, matching `needle` by name; and a reload for both. */
export function useChatRows(needle = '') {
  const home = useHome()
  const groups = useApi<{ conversations: GroupSummary[] }>(home.data ? `/api/conversations?workspaceId=${home.data.workspace.id}` : null, 30_000)
  const match = (name: string) => !needle || name.toLowerCase().includes(needle)
  const rows: ChatRow[] = [
    ...(home.data?.bots ?? []).filter(bot => match(bot.name)).map(bot => ({ kind: 'bot' as const, bot, at: bot.at ?? '' })),
    ...(groups.data?.conversations ?? []).filter(group => match(group.title))
      .map(group => ({ kind: 'group' as const, group, at: group.lastMessage?.createdAt ?? group.createdAt })),
  ].sort((a, b) => b.at.localeCompare(a.at))
  const reload = async () => { await Promise.all([home.reload(), groups.reload()]) }
  return { rows, loading: home.loading, reload }
}

export const rowKey = (row: ChatRow) => row.kind === 'bot' ? row.bot.id : row.group.id

/** A bot (avatar, name, last line, when) or a group chat (a people symbol, its last message, a dot while unread), as a messaging app's list. */
export function ChatRowView({ row, onPress }: { row: ChatRow; onPress: () => void }) {
  const bot = row.kind === 'bot' ? row.bot : null
  const group = row.kind === 'group' ? row.group : null
  // A bot's line is plain text from the server; an empty one is a card with no words.
  const line = bot ? (bot.line === '' ? '[卡片]' : bot.line) : group?.lastMessage?.body ?? null
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }]}>
      {bot ? <BotAvatar color={bot.color} shape={bot.shape} size={52} />
        : <View style={styles.groupIcon}><Symbol name="person.2.fill" size={22} color={colors.secondary} web={<Text style={styles.groupGlyph}>群</Text>} /></View>}
      <View style={styles.body}>
        <View style={styles.top}>
          <Text style={styles.name} numberOfLines={1}>{bot ? bot.name : group!.title}</Text>
          {bot?.working ? <Spinner size={13} /> : row.at ? <Text style={styles.when}>{shortWhen(row.at)}</Text> : null}
        </View>
        {line || (group && Number(group.unreadCount) > 0) ? (
          <View style={styles.top}>
            <Text style={[styles.line, { flex: 1 }]} numberOfLines={1}>{line ?? ''}</Text>
            {group && Number(group.unreadCount) > 0 ? <View style={styles.unread} /> : null}
          </View>
        ) : null}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 10 },
  body: { flex: 1, minWidth: 0, gap: 3 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { flex: 1, fontSize: 17, fontWeight: '600' },
  when: { fontSize: 13, color: colors.tertiary },
  line: { fontSize: 15, color: colors.secondary },
  groupIcon: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.bubble, alignItems: 'center', justifyContent: 'center' },
  groupGlyph: { fontSize: 18, color: colors.secondary },
  unread: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent },
})
