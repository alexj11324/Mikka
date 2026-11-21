/**
 * A child conversation (an independent review or verify, Alex 2026-11-15) shows in the conversation it checks as the
 * Thread's task card, where it started: before the first entry written after it. The conversation's own order is kept.
 */
export function atTheirTime<T extends { at: number }>(entries: readonly T[], children: readonly T[] = []): T[] {
  if (!children.length) return [...entries]
  const out = [...entries]
  for (const child of [...children].sort((a, b) => a.at - b.at)) {
    const index = out.findIndex(entry => entry.at > child.at && !children.includes(entry))
    out.splice(index === -1 ? out.length : index, 0, child)
  }
  return out
}
