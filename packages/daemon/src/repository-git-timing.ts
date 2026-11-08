import type { Harness } from '@mikka/protocol'

export type RepositoryGitPhase = 'clone' | 'fetch' | 'remote_head' | 'remote_refs' | 'local'
type Outcome = 'ok' | 'error'
export type RepositoryGitTiming = {
  version: 1; source: 'prepare_run_repository'; clock: 'repository_prepare_monotonic'
  runIdHash: string; harness: Harness; startedAt: number; endedAt: number; ms: number
  outcome: Outcome; truncated: boolean
  phases: { name: `daemon.repository.git.${RepositoryGitPhase}`; startMs: number; endMs: number; ms: number; outcome: Outcome }[]
}
export type RepositoryTimingObserver = (timing: RepositoryGitTiming) => void
const LIMIT = 32
const MAX_BYTES = 8192
const round = (value: number) => Math.round(value * 1000) / 1000

/** One prepare call owns this origin, including retries. Intervals are inclusive:
 * they must not be summed with the repository stage or aligned using storedAt.
 * Only the five observed Git operations are covered, not every repository action. */
export function createRepositoryGitTimer(runIdHash: string, harness: Harness) {
  const origin = performance.now(), startedAt = Date.now()
  const phases: RepositoryGitTiming['phases'] = []
  let closed = false, truncated = false
  return {
    async measure<T>(phase: RepositoryGitPhase, work: () => Promise<T>): Promise<T> {
      const startMs = round(performance.now() - origin)
      let outcome: Outcome = 'error'
      try { const value = await work(); outcome = 'ok'; return value }
      finally {
        try { if (!closed) {
          if (phases.length >= LIMIT) truncated = true
          else {
            const endMs = round(performance.now() - origin)
            phases.push({ name: `daemon.repository.git.${phase}`, startMs, endMs, ms: round(endMs - startMs), outcome })
          }
        } } catch { truncated = true }
      }
    },
    finish(outcome: Outcome): RepositoryGitTiming {
      closed = true
      const result: RepositoryGitTiming = { version: 1, source: 'prepare_run_repository', clock: 'repository_prepare_monotonic',
        runIdHash, harness, startedAt, endedAt: Math.max(startedAt, Date.now()), ms: round(performance.now() - origin),
        outcome, phases: [...phases], truncated }
      while (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES && result.phases.length) {
        result.phases.pop(); result.truncated = true
      }
      return result
    },
  }
}
export type RepositoryGitTimer = ReturnType<typeof createRepositoryGitTimer>
