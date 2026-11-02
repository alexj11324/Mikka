import { withBasePath } from '@/lib/base-path'

// Client side of GET /api/mobile/reactions (lib/reactions.ts): reactions people
// gave on the phone, by message id, most given first. The web shows them as
// chips under the message (decision 2026-11-01-0030-mobile-reactions).

export type MessageReaction = { emoji: string; count: number; mine: boolean }
export type MessageReactions = Record<string, MessageReaction[]>

/** The route reads at most this many ids per request. */
export const REACTION_IDS_PER_REQUEST = 100

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One URL per hundred stored message ids; ids that are not stored rows (pending, positions) are left out. */
export function reactionUrls(messageIds: readonly (string | null | undefined)[]) {
  const ids = [...new Set(messageIds.filter((id): id is string => !!id && UUID.test(id)))].sort()
  const urls: string[] = []
  for (let start = 0; start < ids.length; start += REACTION_IDS_PER_REQUEST) {
    urls.push(withBasePath(`/api/mobile/reactions?ids=${ids.slice(start, start + REACTION_IDS_PER_REQUEST).join(',')}`))
  }
  return urls
}

/** Reactions on these messages. A failed read shows none: chips are extra, never in the way of the chat. */
export async function fetchMessageReactions(urls: readonly string[], fetcher: typeof fetch = fetch): Promise<MessageReactions> {
  const pages = await Promise.all(urls.map(async url => {
    try {
      const response = await fetcher(url, { cache: 'no-store', credentials: 'same-origin' })
      const body = await response.json().catch(() => null) as { reactions?: unknown } | null
      return response.ok && body?.reactions && typeof body.reactions === 'object' ? body.reactions as MessageReactions : {}
    } catch { return {} }
  }))
  return Object.assign({}, ...pages)
}
