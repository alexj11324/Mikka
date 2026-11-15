import { useCallback, useState } from 'react'
import * as Clipboard from 'expo-clipboard'
import { useChatRows, type ChatRow } from '@/components/ChatList'
import { api, ApiError } from '@/lib/api'
import { tap, warn } from '@/lib/haptics'
import { useHome } from '@/lib/home'
import { MAX_PINS, type ListChat } from './home-list'

/** A chat on the home list: its place (home-list.ts) and the row it draws. */
export type HomeChat = ListChat & { row: ChatRow }
export type ChatChange = Partial<Pick<ListChat, 'pinned' | 'hidden' | 'markedUnread'>>

const keyOf = (row: ChatRow) => row.kind === 'bot' ? row.bot.id : row.group.id

/**
 * The home list's chats with the person's own state, and what the list can do to one: pin, hide, mark read or
 * unread. A change shows at once and is written to the server; a write that fails puts it back.
 */
export function useHomeChats(needle = '') {
  const home = useHome()
  const { rows, loading, error, reload } = useChatRows(needle)
  // Changes shown before the server has them; cleared once the home read that follows the write has them.
  const [pending, setPending] = useState<Record<string, ChatChange & { pinOrder?: number | null; listOrder?: number | null }>>({})
  const groups = home.data?.groupPreferences ?? {}
  const chats: HomeChat[] = rows.map(row => {
    const key = keyOf(row)
    const own = row.kind === 'bot' ? row.bot : groups[key]
    const base: HomeChat = {
      key, row, kind: row.kind, at: row.at,
      pinned: row.kind === 'bot' ? Boolean(row.bot.pinned) : Boolean(groups[key]?.pinned),
      hidden: Boolean(own?.hidden), markedUnread: Boolean(own?.markedUnread),
      pinOrder: own?.pinOrder ?? null, listOrder: own?.listOrder ?? null,
      coordinator: row.kind === 'bot' && Boolean(row.bot.coordinator), working: row.kind === 'bot' && row.bot.working,
      unread: row.kind === 'group' ? Number(row.group.unreadCount) || 0 : row.bot.unreadCount ?? 0,
      waiting: row.kind === 'bot' ? row.bot.waiting ?? 0 : 0,
    }
    return { ...base, ...pending[key] }
  })
  const pinnedCount = chats.filter(chat => chat.pinned && !chat.hidden).length

  const write = useCallback(async (chat: HomeChat, change: ChatChange) => {
    setPending(current => ({ ...current, [chat.key]: { ...current[chat.key], ...change } }))
    try {
      await api(chat.kind === 'bot' ? `/api/mobile/bots/${chat.row.kind === 'bot' && chat.row.bot.coordinator ? 'coordinator' : chat.key}` : `/api/mobile/groups/${chat.key}`, { method: 'PATCH', body: change })
      await reload()
      return true
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'pinLimit') warn()
      return false
    } finally {
      setPending(current => { const { [chat.key]: _, ...rest } = current; return rest })
    }
  }, [reload])

  /** Pins or unpins; past the limit it gives the warning tick and changes nothing. */
  const togglePin = useCallback(async (chat: HomeChat, withTick = true) => {
    if (!chat.pinned && pinnedCount >= MAX_PINS) { warn(); return false }
    if (withTick) tap()
    return write(chat, { pinned: !chat.pinned })
  }, [pinnedCount, write])

  const setHidden = useCallback((chat: HomeChat, hidden: boolean) => write(chat, { hidden }), [write])

  /** 标为已读 clears the hand mark and, in a group chat, reads up to its latest message; 标为未读 sets the mark. */
  const setUnread = useCallback(async (chat: HomeChat, unread: boolean) => {
    if (unread) return write(chat, { markedUnread: true })
    if (chat.row.kind === 'group' && chat.unread > 0 && chat.row.group.lastMessage) {
      await api(`/api/conversations/${chat.key}/read`, { method: 'POST', body: { messageId: chat.row.group.lastMessage.id } }).catch(() => undefined)
    }
    return chat.markedUnread ? write(chat, { markedUnread: false }) : (await reload(), true)
  }, [reload, write])

  const copyId = useCallback((chat: HomeChat) => { void Clipboard.setStringAsync(chat.key); tap() }, [])

  return { chats, loading, error, reload, togglePin, setHidden, setUnread, copyId, pinsFull: pinnedCount >= MAX_PINS }
}
