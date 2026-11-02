/**
 * Where a board opens (usability review N5): on a phone one column fills the screen, so a board whose first
 * columns are empty looked like it had no tasks. It opens on the first shown column with a task; null when
 * the first shown column has one already, or no column does (nothing to move to).
 */
export function boardStartColumn(shown: readonly string[], counts: Readonly<Record<string, number>>): string | null {
  const first = shown.find(column => (counts[column] ?? 0) > 0)
  return first && first !== shown[0] ? first : null
}

/** How far to scroll the board so `column` starts at its left edge, or null when it is already in full view. */
export function boardScrollTo(column: { left: number; right: number }, viewport: { left: number; right: number }, scrollLeft: number): number | null {
  if (column.left >= viewport.left && column.right <= viewport.right) return null
  return Math.max(0, scrollLeft + column.left - viewport.left)
}
