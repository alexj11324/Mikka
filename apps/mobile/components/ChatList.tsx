import type { ReactNode } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { BotAvatar, Spinner } from '@/components/icons'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { chatLine } from '@/lib/chat-line'
import { shortWhen } from '@/lib/clock'
import { useHome } from '@/lib/home'
import type { GroupSummary, HomeBot } from '@/lib/types'
import { useLiveApi } from '@/lib/useApi'
import { listRef } from '@/lib/live'
import { colors } from '@/lib/theme'

export type ChatRow = { kind: 'bot'; bot: HomeBot; at: string } | { kind: 'group'; group: GroupSummary; at: string }

/** The person's bots and group chats, newest first, matching `needle` by name; and a reload for both. */
export function useChatRows(needle = '') {
  const home = useHome()
  const workspaceId = home.data?.workspace.id ?? null
  // The web's group list key (hooks/use-live-lists.ts): a message, a member or a read in one of these groups.
  const groups = useLiveApi<{ conversations: GroupSummary[] }>(workspaceId ? `/api/conversations?workspaceId=${workspaceId}` : null,
    () => ({ refs: [listRef('group_list', workspaceId)], minIntervalMs: 2_000 }))
  const match = (name: string) => !needle || name.toLowerCase().includes(needle)
  const rows: ChatRow[] = [
    // The Coordinator's bot row is the pinned Coordinator entry, not another row.
    ...(home.data?.bots ?? []).filter(bot => match(bot.name)).map(bot => ({ kind: 'bot' as const, bot, at: bot.at ?? '' })),
    ...(groups.data?.conversations ?? []).filter(group => match(group.title))
      .map(group => ({ kind: 'group' as const, group, at: group.lastMessage?.createdAt ?? group.createdAt })),
  ].sort((a, b) => b.at.localeCompare(a.at))
  const reload = async () => { await Promise.all([home.reload(), groups.reload()]) }
  // Keep cached rows visible, but surface either failed source so missing groups are not an empty search result.
  return { rows, loading: home.loading || groups.loading, error: home.error || groups.error, reload }
}

export const rowKey = (row: ChatRow) => row.kind === 'bot' ? row.bot.id : row.group.id

/** A bot (avatar, name, last line, when) or a group chat (a people symbol, its last message, a dot while unread), as a messaging app's list. */
export function ChatRowView({ row, onPress }: { row: ChatRow; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => pressed && { backgroundColor: colors.pressed }}>
      <ChatRowContent row={row} />
    </Pressable>
  )
}

/**
 * What a chat row draws, without its press: the home list wraps it in its link, swipe and drag. `badge` replaces the
 * unread dot with a mark on the avatar's corner (features/home `ChatBadge`).
 */
export function ChatRowContent({ row, badge }: { row: ChatRow; badge?: ReactNode }) {
  const bot = row.kind === 'bot' ? row.bot : null
  const group = row.kind === 'group' ? row.group : null
  const line = chatLine(bot ? { bot } : { group: group! })
  const dot = badge === undefined && group && Number(group.unreadCount) > 0
  return (
    <View style={styles.row}>
      <View>
        {bot ? <BotAvatar color={bot.color} shape={bot.shape} size={54} />
          : <View style={styles.groupIcon}><Symbol name="person.2.fill" size={22} color={colors.secondary} web={<Text style={styles.groupGlyph}>群</Text>} /></View>}
        {badge}
      </View>
      <View style={styles.body}>
        <View style={styles.top}>
          <Text style={styles.name} numberOfLines={1}>{bot ? bot.name : group!.title}</Text>
          {bot?.working ? <Spinner size={13} /> : row.at ? <Text style={styles.when}>{shortWhen(row.at)}</Text> : null}
        </View>
        {line || dot ? (
          <View style={styles.top}>
            <Text style={[styles.line, { flex: 1 }]} numberOfLines={1}>{line ?? ''}</Text>
            {dot ? <View style={styles.unread} /> : null}
          </View>
        ) : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 10 },
  body: { flex: 1, minWidth: 0, gap: 3 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { flex: 1, fontSize: 16, lineHeight: 21, fontWeight: '600' },
  when: { fontSize: 13, color: colors.secondary },
  line: { fontSize: 14, lineHeight: 19, color: colors.secondary },
  groupIcon: { width: 54, height: 54, borderRadius: 27, backgroundColor: colors.bubble, alignItems: 'center', justifyContent: 'center' },
  groupGlyph: { fontSize: 18, color: colors.secondary },
  unread: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent },
})
