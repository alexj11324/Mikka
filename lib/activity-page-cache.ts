/** Keep the fetched revision window contiguous when new activity is polled. */
export type ActivityPage<T> = { version: string; items: T[]; hasMore: boolean; predecessor?: T | null }
type OrderedActivity = { id: string; revision: number }

export function mergeActivityRows<T extends OrderedActivity>(current: T[], incoming: T[]): T[] {
  const rows = new Map(current.map(row => [row.id, row]))
  for (const row of incoming) rows.set(row.id, row)
  return [...rows.values()].sort((a, b) => b.revision - a.revision || b.id.localeCompare(a.id))
}

export function mergeActivityPoll<T extends OrderedActivity>(previous: ActivityPage<T> | undefined, next: ActivityPage<T>): ActivityPage<T> {
  if (!previous?.items.length) return next
  const ids = new Set(previous.items.map(row => row.id))
  // If over a page of new revisions arrived, retaining the old tail would make
  // the older cursor jump across unseen revisions. Reset to the newest window.
  if (next.items.length && !next.items.some(row => ids.has(row.id))) return next
  // The older cursor points to the retained tail, not the end of the new poll.
  return { version: next.version, items: mergeActivityRows(previous.items, next.items), hasMore: previous.hasMore, predecessor: previous.predecessor ?? null }
}

/** Ignore an older-page response if a newer poll replaced the window it belongs to. */
export function mergeActivityEarlier<T extends OrderedActivity>(current: ActivityPage<T> | undefined, beforeId: string, page: { items: T[]; hasMore: boolean; predecessor?: T | null }): ActivityPage<T> | undefined {
  if (!current || current.items.at(-1)?.id !== beforeId) return current
  return { ...current, items: mergeActivityRows(current.items, page.items), hasMore: page.hasMore, predecessor: page.predecessor ?? null }
}
