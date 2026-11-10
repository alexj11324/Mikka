import { mobileMessages } from '@/lib/messages'
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
import { AVATAR, colors, LIST_INSET, ROW_SURFACE_INSET, SPACE } from '@/lib/theme'

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
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.press, pressed && { backgroundColor: colors.pressed }]}>
      <ChatRowContent row={row} />
    </Pressable>
  )
}

/**
 * What a chat row draws, without its press: the home list wraps it in its link, swipe and drag. Avatar 44, name 17
 * semibold, last line 15, time 13 (Comma design 01); a working bot says 进行中 where the time goes. `badge` takes the
 * place of a group's unread dot, on the right under the time (features/home `ChatBadge`).
 */
export function ChatRowContent({ row, badge }: { row: ChatRow; badge?: ReactNode }) {
  const bot = row.kind === 'bot' ? row.bot : null
  const group = row.kind === 'group' ? row.group : null
  const line = chatLine(bot ? { bot } : { group: group! })
  const dot = badge === undefined && group && Number(group.unreadCount) > 0
  return (
    <View style={styles.row}>
      {bot ? <BotAvatar id={bot.id} coordinator={bot.coordinator} color={bot.color} shape={bot.shape} size={AVATAR.row} />
        : <View style={styles.groupIcon}><Symbol name="person.2.fill" size={18} color={colors.secondary} web={<Text style={styles.groupGlyph}>{mobileMessages.MobileCore.groupGlyph}</Text>} /></View>}
      <View style={styles.body}>
        <View style={styles.top}>
          <Text style={styles.name} numberOfLines={1}>{bot ? bot.name : group!.title}</Text>
          {bot?.working ? <Text style={styles.when}>{mobileMessages.Issue.status.doing}</Text> : row.at ? <Text style={styles.when}>{shortWhen(row.at)}</Text> : null}
        </View>
        {line || dot || badge ? (
          <View style={styles.top}>
            <Text style={[styles.line, { flex: 1 }]} numberOfLines={1}>{line ?? ''}</Text>
            {dot ? <View style={styles.unread} /> : badge}
          </View>
        ) : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  /** The pressed surface sits 6 pt in from each side, rounded 10; the row's text lands 20 pt in (lib/theme.ts). */
  press: { marginHorizontal: ROW_SURFACE_INSET, borderRadius: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: LIST_INSET - ROW_SURFACE_INSET, paddingVertical: SPACE.rowY },
  body: { flex: 1, minWidth: 0, gap: SPACE.lineGap },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { flex: 1, fontSize: 17, lineHeight: 22, fontWeight: '600' },
  when: { fontSize: 13, lineHeight: 18, color: colors.secondary },
  line: { fontSize: 15, lineHeight: 20, color: colors.secondary },
  groupIcon: { width: AVATAR.row, height: AVATAR.row, borderRadius: AVATAR.row / 2, backgroundColor: colors.bubble, alignItems: 'center', justifyContent: 'center' },
  groupGlyph: { fontSize: 15, color: colors.secondary },
  unread: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent },
})
