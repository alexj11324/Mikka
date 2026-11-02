import { matchesQuery } from './site-search'

/**
 * ⌘K's 线程 group (usability review D4/M10): threads the shell already loaded whose name, request or last
 * reply contains every word of the query. Newest activity first, as the thread list orders them; capped so
 * the group never buries the ones after it.
 */
export const THREAD_SEARCH_LIMIT = 8

export function threadSearchHits<T extends { prompt: string; lastReply: string | null }>(threads: readonly T[], query: string, name: (thread: T) => string): { thread: T; name: string }[] {
  if (!query.trim()) return []
  const hits: { thread: T; name: string }[] = []
  for (const thread of threads) {
    const label = name(thread)
    if (!matchesQuery(`${label} ${thread.prompt} ${thread.lastReply ?? ''}`, query)) continue
    hits.push({ thread, name: label })
    if (hits.length === THREAD_SEARCH_LIMIT) break
  }
  return hits
}
