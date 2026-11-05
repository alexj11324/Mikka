/** Fingerprints of the rows actually held by this reader, in server order.
 * These are read cursors, not live-channel versions or authorization grants. */
export type ListPosition = { id: string; version: string }
export type ListSnapshot<T> = { version: string; items: T[]; positions?: ListPosition[] }
export type ListPoll<T> = ListSnapshot<T> | { version: string; items: T[]; positions: ListPosition[]; delta: true } | { version: string; unchanged: true }

/** Invalid/oversized client cursors request a normal snapshot. Never trust a
 * cursor for visibility: readers rebuild the authorized row set each time. */
export function readListPositions(value: unknown, limit: number): ListPosition[] | undefined {
  if (!Array.isArray(value) || value.length > limit) return undefined
  const seen = new Set<string>()
  for (const row of value) {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || typeof row.version !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id)
      || !/^[0-9a-f]{32}$/.test(row.version) || seen.has(row.id)) return undefined
    seen.add(row.id)
  }
  return value.map(({ id, version }) => ({ id, version }))
}

/** A partial/mutated local cache only claims rows it still contains. */
export function heldListPositions<T extends { id: string }>(snapshot: { items: T[]; positions?: ListPosition[] } | undefined) {
  if (!snapshot?.positions) return undefined
  const ids = new Set(snapshot.items.map(item => item.id))
  return snapshot.positions.filter(row => ids.has(row.id))
}

export function changedListIds(positions: readonly ListPosition[], previous: readonly ListPosition[] | undefined) {
  const known = new Map(previous?.map(row => [row.id, row.version]))
  return positions.filter(row => known.get(row.id) !== row.version).map(row => row.id)
}

/** Keep the latest cache value when an in-flight unchanged response completes. */
export function mergeList<T extends { id: string }>(current: T[], next: ListPoll<T>): T[] {
  if ('unchanged' in next) return current
  if (!('delta' in next)) return next.items
  const rows = new Map([...current, ...next.items].map(item => [item.id, item]))
  // The server's full, small id manifest removes deleted, revoked and expired
  // rows, including a deletion with no later row timestamp to act as a cursor.
  return next.positions.flatMap(({ id }) => { const item = rows.get(id); return item ? [item] : [] })
}
