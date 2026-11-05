import { parseChatOrder, type ChatOrder } from './chat-order'
import type { ReadMark } from './chat-read'

/** The list arrangement kept on this device: order, collapsed sections, and read marks from the row menu. */
export type HomeListSave = {
  order: ChatOrder | null
  collapsed: string[]
  read: Record<string, ReadMark>
}

const EMPTY: HomeListSave = { order: null, collapsed: [], read: {} }

export function parseHomeList(raw: string | null): HomeListSave {
  if (!raw) return EMPTY
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return EMPTY
    const record = value as { order?: unknown; collapsed?: unknown; read?: unknown }
    const read: Record<string, ReadMark> = {}
    if (record.read && typeof record.read === 'object') {
      for (const [id, mark] of Object.entries(record.read as Record<string, unknown>)) {
        if (!mark || typeof mark !== 'object') continue
        const item = mark as { at?: unknown; state?: unknown }
        if (typeof item.at === 'string' && (item.state === 'read' || item.state === 'unread')) read[id] = { at: item.at, state: item.state }
      }
    }
    return {
      order: parseChatOrder(record.order === undefined ? null : JSON.stringify(record.order)),
      collapsed: Array.isArray(record.collapsed) ? record.collapsed.filter((id): id is string => typeof id === 'string') : [],
      read,
    }
  } catch {
    return EMPTY
  }
}
