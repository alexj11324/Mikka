import type { Result } from './snapshot'

/** Persist one row per task/PR, updating it under a lock. */
export type Observation = { head: string; fingerprint: string | null; firstSeenAt: number; deliveredFingerprint: string | null }
export type Decision = { state: Observation | null; deliver: boolean }

/** Require two identical complete snapshots separated by a quiet window. The caller
 * must lock and revalidate the task and current PR head immediately before delivery. */
export function observe(previous: Observation | null, head: string, result: Result, now: number, quietMs: number): Decision {
  if (result.kind === 'pending') return { state: previous?.head === head ? { ...previous, fingerprint: null, firstSeenAt: now } : null, deliver: false }
  if (!previous || previous.head !== head || previous.fingerprint !== result.fingerprint) {
    return { state: { head, fingerprint: result.fingerprint, firstSeenAt: now, deliveredFingerprint: previous?.head === head ? previous.deliveredFingerprint : null }, deliver: false }
  }
  // Once a result for this head was handed off, a later provider snapshot or
  // rerun must not wake the same agent again for the same commit.
  return { state: previous, deliver: previous.deliveredFingerprint === null && now - previous.firstSeenAt >= quietMs }
}
