import { matchesQuery } from './site-search'

/**
 * ⌘K's 线程 group (usability review D4/M10): threads the shell already loaded whose name, request or last
 * reply contains every word of the query. Newest activity first, as the thread list orders them; capped so
 * the group never buries the ones after it.
 */
export const THREAD_SEARCH_LIMIT = 8

export function threadSearchHits<T extends { prompt: string; lastReply: string | null; issueId?: string | null }>(threads: readonly T[], query: string, name: (thread: T) => string, listedTasks: ReadonlySet<string> = new Set()): { thread: T; name: string }[] {
  if (!query.trim()) return []
  const hits: { thread: T; name: string }[] = []
  // A task's attempts share its name: only its newest stands for it, and none when 任务 already lists the task.
  const seenTasks = new Set(listedTasks)
  for (const thread of threads) {
    if (thread.issueId && seenTasks.has(thread.issueId)) continue
    const label = name(thread)
    if (!matchesQuery(`${label} ${thread.prompt} ${thread.lastReply ?? ''}`, query)) continue
    if (thread.issueId) seenTasks.add(thread.issueId)
    hits.push({ thread, name: label })
    if (hits.length === THREAD_SEARCH_LIMIT) break
  }
  return hits
}
