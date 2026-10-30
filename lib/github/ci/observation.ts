import type { Result } from './snapshot'

/** Persist one row per task/PR, updating it under a lock. */
export type Observation = { head: string; fingerprint: string | null; firstSeenAt: number }
export type Decision = { state: Observation | null; stable: boolean }

/** Require two identical complete snapshots separated by a quiet window. Whether
 * this head was already resumed is the budget ledger's job (lib/github/ci/budget.ts);
 * the caller locks and revalidates the task and current PR head before delivery. */
export function observe(previous: Observation | null, head: string, result: Result, now: number, quietMs: number): Decision {
  if (result.kind === 'pending') return { state: previous?.head === head ? { ...previous, fingerprint: null, firstSeenAt: now } : null, stable: false }
  if (!previous || previous.head !== head || previous.fingerprint !== result.fingerprint) return { state: { head, fingerprint: result.fingerprint, firstSeenAt: now }, stable: false }
  return { state: previous, stable: now - previous.firstSeenAt >= quietMs }
}
