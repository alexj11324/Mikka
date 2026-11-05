import type { ComputerState } from '@mikka/protocol/computer'

/** The earliest observed expiry needs a fresh read. A recurring heartbeat
 * extends the next read only when the server actually observes that extension. */
export function computerLiveState(workspaceId: string, deadlines: readonly (Date | string | number | null | undefined)[], now = Date.now()): NonNullable<ComputerState['live']> {
  const dates = deadlines.filter(value => value != null).map(value => new Date(value!).getTime()).filter(Number.isFinite)
  if (!dates.length) return { workspaceId }
  const expiresAt = Math.min(...dates)
  return { workspaceId, deadline: { at: new Date(expiresAt).toISOString(), afterMs: Math.max(0, Math.ceil(expiresAt - now)) } }
}

/** Conservative browser deadline, anchored before the authenticated request.
 * The shared scheduler also uses a monotonic clock; wall-clock adjustments
 * cannot extend the server's observed lifetime. An unanchored cached value
 * requires an immediate read rather than assuming it just arrived. A new
 * authenticated response may rearm an already-consumed early deadline; its
 * request-start observation distinguishes that response from a cached render. */
export function computerReadDeadline(read: (ComputerState & { requestedAt?: number }) | undefined, now = performance.now()) {
  const deadline = read?.live?.deadline
  if (!deadline || !read) return undefined
  const elapsed = Number.isFinite(read.requestedAt) ? Math.max(0, now - read.requestedAt!) : Infinity
  return {
    at: deadline.at,
    afterMs: Math.max(0, deadline.afterMs - elapsed),
    ...(deadline.afterMs > 0 && Number.isFinite(read.requestedAt) ? { observation: read.requestedAt! } : {}),
  }
}
