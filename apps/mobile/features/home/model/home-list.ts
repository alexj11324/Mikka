import { mobileMessages } from '@/lib/messages'
/**
 * The home chat list (#1408 Phase 2b), as pure data: which chats show where, in what order and with what badge. The
 * screen draws it; the server keeps only each chat's own state (chat-preferences). The list is newest first: chats are
 * not dragged (Alex 2026-11-07, superseding 2026-11-05-2010), so an order stored by an earlier drag is left unread.
 */

/** One chat's place on the list: its key, kind, recency and the person's own state for it. */
export type ListChat = {
  key: string
  kind: 'bot' | 'group'
  at: string
  pinned: boolean
  hidden: boolean
  pinOrder: number | null
  listOrder: number | null
  /** Coordinator first among unplaced pins. */
  coordinator: boolean
  working: boolean
  /** Messages the person has not read (a group chat's count). */
  unread: number
  markedUnread: boolean
  /** Threads waiting on the person. */
  waiting: number
}

export type SectionId = 'working' | 'bots' | 'groups'
export const SECTION_TITLES: Record<SectionId, string> = { working: mobileMessages.MobileCore.working, bots: 'Bot', groups: mobileMessages.MobileCore.groupChats }
const SECTIONS: readonly SectionId[] = ['working', 'bots', 'groups']

export type HomeItem<C> =
  | { kind: 'section'; id: SectionId; title: string; count: number; collapsed: boolean; unread: number }
  | { kind: 'chat'; chat: C; section: SectionId }

/** The most chats pinned at once (the server's MAX_PINNED_CHATS): four rows of the pin grid. */
export const MAX_PINS = 16

const byOrder = (order: (chat: ListChat) => number | null) => (a: ListChat, b: ListChat) => {
  const x = order(a), y = order(b)
  // A chat the person never placed comes first, newest first: a new chat shows at the top.
  if (x === null && y === null) return b.at.localeCompare(a.at)
  if (x === null) return -1
  if (y === null) return 1
  return x - y
}

export const sectionOf = (chat: ListChat): SectionId => chat.kind === 'group' ? 'groups' : chat.working ? 'working' : 'bots'

/** How much a chat counts toward a closed section's unread number. */
export const unreadOf = (chat: ListChat) => chat.unread || (chat.markedUnread ? 1 : 0)

/** The pins, in order (the Coordinator first among the never-placed), and the list in sections. A search is one plain run. */
export function homeList<C extends ListChat>(chats: readonly C[], options: { searching: boolean; collapsed: ReadonlySet<SectionId> }) {
  const shown = chats.filter(chat => !chat.hidden)
  const hidden = chats.length - shown.length
  if (options.searching) return { pinned: [] as C[], items: shown.map((chat): HomeItem<C> => ({ kind: 'chat', chat, section: sectionOf(chat) })), hidden }
  const pinned = shown.filter(chat => chat.pinned).sort((a, b) => a.pinOrder === null && b.pinOrder === null
    ? Number(b.coordinator) - Number(a.coordinator) || b.at.localeCompare(a.at)
    : byOrder(chat => chat.pinOrder)(a, b))
  const rest = shown.filter(chat => !chat.pinned).sort((a, b) => b.at.localeCompare(a.at))
  const items = SECTIONS.flatMap((id): HomeItem<C>[] => {
    const list = rest.filter(chat => sectionOf(chat) === id)
    if (!list.length) return []
    const rows = list.map((chat): HomeItem<C> => ({ kind: 'chat', chat, section: id }))
    // The page's large title is Bot, so the bots that open the list carry no second 「Bot」 header (2026-11-07).
    if (id === 'bots' && !rest.some(chat => sectionOf(chat) === 'working')) return rows
    const collapsed = options.collapsed.has(id)
    const header: HomeItem<C> = { kind: 'section', id, title: SECTION_TITLES[id], count: list.length, collapsed, unread: list.reduce((sum, chat) => sum + unreadOf(chat), 0) }
    return [header, ...(collapsed ? [] : rows)]
  })
  return { pinned, items, hidden }
}

/** The mark on a chat's avatar: a waiting mark outranks the unread count; a chat marked unread by hand shows a dot. */
export function badgeOf(chat: ListChat): { kind: 'waiting' } | { kind: 'count'; count: number } | { kind: 'dot' } | null {
  if (chat.waiting > 0) return { kind: 'waiting' }
  if (chat.unread > 0) return { kind: 'count', count: chat.unread }
  return chat.markedUnread ? { kind: 'dot' } : null
}
