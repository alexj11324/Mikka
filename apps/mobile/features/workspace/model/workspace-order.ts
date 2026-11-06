/**
 * The order of the workspaces in the drawer, as the person arranged it on this phone. The server has no order for
 * them, so the arrangement is a list of ids kept on the device; workspaces it does not name follow in the server's
 * order, and ids of workspaces that are gone are dropped.
 */
export function orderWorkspaces<W extends { id: string }>(workspaces: readonly W[], saved: readonly string[]): W[] {
  const byId = new Map(workspaces.map(w => [w.id, w]))
  const known = saved.flatMap(id => byId.get(id) ?? [])
  const placed = new Set(known.map(w => w.id))
  return [...known, ...workspaces.filter(w => !placed.has(w.id))]
}

/** The ids after moving one workspace a step up (-1) or down (1); a move past either end changes nothing. */
export function moveWorkspace(ids: readonly string[], id: string, step: -1 | 1): string[] {
  const from = ids.indexOf(id), to = from + step
  if (from < 0 || to < 0 || to >= ids.length) return [...ids]
  const next = [...ids]
  next.splice(from, 1)
  next.splice(to, 0, id)
  return next
}

/** A saved arrangement read back: a list of ids, or nothing when it is missing or unreadable. */
export function parseWorkspaceOrder(raw: string | null): string[] {
  if (!raw) return []
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

/** The ids after a drag moves the workspace at `from` to `to`, both clamped into the list. */
export function moveTo(ids: readonly string[], from: number, to: number): string[] {
  const next = [...ids]
  if (from < 0 || from >= ids.length) return next
  const [id] = next.splice(from, 1)
  next.splice(Math.max(0, Math.min(to, next.length)), 0, id!)
  return next
}

/** The place a dragged row reaches: its start plus whole rows of travel, inside the list. */
export function dragSlot(from: number, travel: number, rowHeight: number, count: number): number {
  'worklet'
  return Math.max(0, Math.min(count - 1, from + Math.round(travel / rowHeight)))
}
