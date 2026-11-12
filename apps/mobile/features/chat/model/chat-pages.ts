import type { Chat, ChatItem, GroupMessage, GroupPage } from '@/lib/types'

/**
 * Chats load a page at a time (#1408): the latest `CHAT_PAGE` messages when a chat opens, the page before when the
 * reader scrolls to the top, and on a push only what is new since the last read. These functions build the requests
 * and merge their answers; the screens hold the result.
 */
export const CHAT_PAGE = 50

/** Where a bot chat's last read ended (the server's `ChatView.continuation`). */
export type ChatContinuation = { after: number; cursor: number; prefix: string }

/** A bot chat as it is read and kept: the server adds where to continue from, and an update read says what it replaces. */
export type ChatRead = Chat & {
  /** The server includes the immutable submission ID on newly recorded personal messages. */
  submissionIds?: true
  /** Local receipts already acknowledged when an older server's successful snapshot started. */
  acknowledgedBeforeRead?: string[]
  continuation?: ChatContinuation
  /** Older messages exist before this position. */
  historyBefore?: number | null
  /** An update read: its items replace everything after this position. */
  after?: number
  /** The `cursor` the update read continued from. */
  baseCursor?: number
}

/** Old servers lack per-message receipts. A fresh authorized snapshot replaces only previously acknowledged local sends. */
export function personalReadback(next: ChatRead, acknowledged: string[]): ChatRead {
  if (next.submissionIds || next.items.some(item => item.from === 'person' && item.submissionId)) {
    return { ...next, submissionIds: true, acknowledgedBeforeRead: undefined }
  }
  return { ...next, acknowledgedBeforeRead: acknowledged }
}

/** An older page of a bot chat (`&through=`). */
export type ChatHistoryPage = Pick<Chat, 'items' | 'sources' | 'artifacts' | 'reactions'> & { historyBefore: number | null }

/** The read for a push: only what came after the chat's last read, when it knows where that ended. */
export function chatUpdatePath(path: string, chat: ChatRead | null) {
  const continuation = chat?.continuation
  if (!continuation) return path
  const query = `after=${continuation.after}&cursor=${continuation.cursor}&prefix=${continuation.prefix}`
  return `${path}${path.includes('?') ? '&' : '?'}${query}`
}

const persisted = (items: ChatItem[]) => items.filter(item => !item.pending)

/**
 * The chat after a read. An update keeps what it had up to `after` and appends what the read returned; a full read
 * (the latest page) keeps the older pages already loaded when the two overlap, so a push never drops history the
 * reader scrolled up to.
 */
export function mergeChatRead(previous: ChatRead | null, next: ChatRead): ChatRead {
  if (!previous) return next
  if (next.after !== undefined) {
    // The chat moved on while this read was out (a send read it again): the newer one stays.
    if (previous.continuation?.cursor !== next.baseCursor) return previous
    const { after, baseCursor: _baseCursor, ...rest } = next
    const items = [...persisted(previous.items).filter(item => item.position <= after), ...next.items]
    return { ...rest, items, sources: { ...previous.sources, ...next.sources }, artifacts: { ...previous.artifacts, ...next.artifacts },
      reactions: keptReactions(previous, items, next.reactions), historyBefore: previous.historyBefore }
  }
  const first = persisted(next.items)[0]?.position
  const last = persisted(previous.items).at(-1)?.position
  // The latest page reaches back into what was shown: keep the older pages in front of it.
  if (first === undefined || last === undefined || first > last + 1 || !next.historyBefore) return next
  const older = persisted(previous.items).filter(item => item.position < first)
  if (!older.length) return next
  const items = [...older, ...next.items]
  return { ...next, items, sources: { ...previous.sources, ...next.sources }, artifacts: { ...previous.artifacts, ...next.artifacts },
    reactions: keptReactions(previous, items, next.reactions), historyBefore: previous.historyBefore }
}

/** Reactions of the messages still shown, the read's own winning. */
function keptReactions(previous: ChatRead, items: ChatItem[], fresh: Chat['reactions']) {
  const ids = new Set(items.flatMap(item => item.id ? [item.id] : []))
  const kept = Object.fromEntries(Object.entries(previous.reactions ?? {}).filter(([id]) => ids.has(id)))
  return { ...kept, ...fresh }
}

/**
 * Where the next older page ends. It overlaps the first shown item by one, as the web's, so a reply made of several
 * stored messages is grouped again whole; null when there is nothing older.
 */
export function olderThrough(chat: ChatRead | null): number | null {
  if (!chat?.historyBefore) return null
  const shown = persisted(chat.items)
  return shown[1] ? shown[1].position - 1 : chat.historyBefore - 1
}

export function chatHistoryPath(path: string, through: number) {
  return `${path}${path.includes('?') ? '&' : '?'}through=${through}`
}

/** An older page in front of the chat: it replaces the shown items up to `through`. */
export function mergeChatHistory(chat: ChatRead, page: ChatHistoryPage, through: number): ChatRead {
  const items = [...page.items, ...chat.items.filter(item => item.pending || item.position > through)]
  return { ...chat, items, sources: { ...chat.sources, ...page.sources }, artifacts: { ...chat.artifacts, ...page.artifacts },
    reactions: { ...chat.reactions, ...page.reactions }, historyBefore: page.historyBefore }
}

/** A group's newest page as the server returns it; `appended` and `unchanged` answer a read with `after`. */
export type GroupRead = GroupPage & { appended?: boolean; unchanged?: boolean }

const newer = (a: GroupMessage, b: GroupMessage) => BigInt(a.position) > BigInt(b.position)

/** The group's newest message position, for the next push's `after`. */
export function newestGroupPosition(messages: GroupMessage[]) {
  return messages.reduce<string | null>((max, message) => max === null || BigInt(message.position) > BigInt(max) ? message.position : max, null)
}

/** The read for a group push: only what came after the newest message it holds. */
export function groupPagePath(id: string, page: GroupRead | null, before?: string | null) {
  const params = new URLSearchParams({ limit: String(CHAT_PAGE) })
  if (before) params.set('before', before)
  else {
    const after = page ? newestGroupPosition(page.messages) : null
    if (after) params.set('after', after)
  }
  return `/api/conversations/${id}/messages?${params}`
}

/**
 * The group after a read: nothing new keeps the messages and takes the new state; appended messages go in front
 * (pages are newest first); a full page replaces the latest messages but keeps older pages it reaches back into.
 */
export function mergeGroupRead(previous: GroupRead | null, next: GroupRead): GroupRead {
  if (!previous) return next
  if (next.unchanged) return { ...previous, agentStatus: next.agentStatus ?? null, routingError: next.routingError ?? null, stopped: next.stopped }
  const { appended: _appended, unchanged: _unchanged, ...rest } = next
  if (next.appended) {
    const seen = new Set(previous.messages.map(message => message.id))
    return { ...rest, messages: [...next.messages.filter(message => !seen.has(message.id)), ...previous.messages], nextBefore: previous.nextBefore }
  }
  const oldest = next.messages.at(-1)
  const reaches = oldest && previous.messages.some(message => message.id === oldest.id)
  if (!reaches || !next.nextBefore) return rest
  const ids = new Set(next.messages.map(message => message.id))
  const older = previous.messages.filter(message => !ids.has(message.id) && newer(oldest, message))
  return { ...rest, messages: [...next.messages, ...older], nextBefore: older.length ? previous.nextBefore : next.nextBefore }
}

/** An older group page behind the messages shown. */
export function mergeGroupHistory(page: GroupRead, older: GroupPage): GroupRead {
  const seen = new Set(page.messages.map(message => message.id))
  return { ...page, messages: [...page.messages, ...older.messages.filter(message => !seen.has(message.id))], nextBefore: older.nextBefore }
}
