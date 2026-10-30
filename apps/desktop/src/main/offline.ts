/** Waits 2s, 4s, 8s, 16s, then 30s between reconnects, and never gives up. */
export function offlineRetryDelay(attempt: number): number {
  return Math.min(30_000, 2_000 * 2 ** Math.max(0, Math.min(attempt, 4)))
}
