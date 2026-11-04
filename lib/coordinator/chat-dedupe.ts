// What a chat leaves out so one object shows once (R-66): later cards of a thread, older repeats of a thread's event
// line, and where the unread divider goes when the row it marked is left out. Pure, for the chat and its tests.

interface Row { position: number; from: string; threads?: readonly string[]; line?: { runId: string | null; kind: string } | null }

/** Each thread's card sits under the first reply that names it among the rows loaded: thread id → that reply's position. */
export function firstThreadCards(rows: readonly Row[]): Map<string, number> {
  const first = new Map<string, number>()
  for (const row of rows) for (const id of row.threads ?? []) if (!first.has(id)) first.set(id, row.position)
  return first
}

/** The positions of a thread's event lines that a later line of the same thread and kind repeats; only the latest shows. */
export function staleEventPositions(rows: readonly Row[]): Set<number> {
  const stale = new Set<number>(), seen = new Set<string>()
  for (const row of [...rows].reverse()) {
    if (row.from !== 'event' || !row.line?.runId) continue
    const key = `${row.line.runId}:${row.line.kind}`
    if (seen.has(key)) stale.add(row.position)
    else seen.add(key)
  }
  return stale
}

/** The unread divider's row once `hidden` rows are left out: the same row, or the next one shown; null when none is. */
export function visibleDivider(divider: number | null | undefined, rows: readonly Row[], hidden: ReadonlySet<number>): number | null {
  if (divider === null || divider === undefined) return null
  if (!hidden.has(divider)) return divider
  return rows.find(row => row.position > divider && !hidden.has(row.position))?.position ?? null
}
