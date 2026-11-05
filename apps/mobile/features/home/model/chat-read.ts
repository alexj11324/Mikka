/** A local read the person set from the row menu. The server's unread count stays the source once a newer line arrives. */

export type ReadMark = { at: string; state: 'read' | 'unread' }

/**
 * How many unread the row shows. Marking read hides the count until a line newer than `at`. Marking unread shows
 * at least one, even when the server has none (a group read only moves forward).
 */
export function shownUnread(server: number, latestAt: string, mark: ReadMark | undefined): number {
  const count = Math.max(0, Math.floor(server))
  if (!mark) return count
  if (mark.state === 'unread') return Math.max(1, count)
  if (latestAt > mark.at) return count
  return 0
}
