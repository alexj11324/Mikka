/**
 * The home chat list (#1408 Phase 2b), as pure data: which chats show where, in what order, with what badge, and
 * what a drag leaves behind. The screen draws it; the server keeps only each chat's own state (chat-preferences).
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
export const SECTION_TITLES: Record<SectionId, string> = { working: '正在工作', bots: 'Bot', groups: '群聊' }
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
  const rest = shown.filter(chat => !chat.pinned).sort(byOrder(chat => chat.listOrder))
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

/** Where a dragged chat lands: a place among the pins, or before a chat of the list (null: the end of its section). */
export type DropTarget = { area: 'pins'; index: number } | { area: 'list'; before: string | null }

/**
 * The order a drop leaves: the pins and the list, each as keys in order. A drop on the pins pins the chat or moves
 * its pin; a drop on the list unpins it and places it before `before`. A chat stays in its own section, which its
 * kind decides, so a drop beside another section's chat lands at the edge of its own. Null when nothing can change.
 */
export function dropOrder(chats: readonly ListChat[], key: string, target: DropTarget): { pinned: string[]; list: string[] } | null {
  const { pinned, items } = homeList(chats, { searching: false, collapsed: new Set() })
  const dragged = chats.find(chat => chat.key === key)
  if (!dragged || dragged.hidden) return null
  const pins = pinned.map(chat => chat.key).filter(k => k !== key)
  const list = items.flatMap(item => item.kind === 'chat' && item.chat.key !== key ? [item.chat] : [])
  if (target.area === 'pins') {
    if (!dragged.pinned && pins.length >= MAX_PINS) return null
    pins.splice(Math.max(0, Math.min(target.index, pins.length)), 0, key)
    return { pinned: pins, list: list.map(chat => chat.key) }
  }
  const own = sectionOf(dragged)
  const before = target.before === null ? null : list.find(chat => chat.key === target.before) ?? null
  let at: number
  if (before && sectionOf(before) === own) at = list.indexOf(before)
  else {
    const mine = list.flatMap((chat, index) => sectionOf(chat) === own ? [index] : [])
    // Beside an earlier section's chat: the top of its own; beside a later one's, or at the end: the end of its own.
    const earlier = before !== null && SECTIONS.indexOf(sectionOf(before)) < SECTIONS.indexOf(own)
    at = mine.length ? (earlier ? mine[0]! : mine.at(-1)! + 1) : list.findIndex(chat => SECTIONS.indexOf(sectionOf(chat)) > SECTIONS.indexOf(own))
    if (at < 0) at = list.length
  }
  list.splice(at, 0, dragged)
  return { pinned: pins, list: list.map(chat => chat.key) }
}
