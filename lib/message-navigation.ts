/** Pure helpers for transcript navigation. Keep geometry queries lazy so
 * a scroll event never has to measure every message row. */
export function closestSortedIndex(
  count: number,
  target: number,
  centerAt: (index: number) => number,
): number {
  if (count <= 0) return -1;
  // Message rows are rendered in document order. Find the first center
  // on or after the viewport center, then compare its predecessor.
  let low = 0;
  let high = count;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (centerAt(mid) < target) low = mid + 1;
    else high = mid;
  }
  if (low === 0) return 0;
  if (low === count) return count - 1;
  return target - centerAt(low - 1) <= centerAt(low) - target
    ? low - 1
    : low;
}

/** Index of the next assistant message after each row, computed in O(n). */
export function nextAssistantIndices(senders: readonly string[]): Array<number | undefined> {
  const next = new Array<number | undefined>(senders.length);
  let upcoming: number | undefined;
  for (let index = senders.length - 1; index >= 0; index -= 1) {
    next[index] = upcoming;
    if (senders[index] === "assistant") upcoming = index;
  }
  return next;
}
