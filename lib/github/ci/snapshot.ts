import { createHash } from 'node:crypto'
import type { WorkflowAttempt } from './attempts'

/** The provider response must be complete and paginated before calling this function. */
export type Check = { id: string; name: string; status: string; conclusion: string | null }
export type CommitStatus = { context: string; state: string; id: string }
export type Snapshot = { checks: Check[]; statuses: CommitStatus[] }
export type Result = { kind: 'pending' } | { kind: 'complete'; outcome: 'success' | 'failure'; failed: string[]; fingerprint: string }

/**
 * Cancelled, timed-out, action-required and failed checks are failures.
 * Neutral/skipped checks are not failures but cannot alone establish success.
 * Unknown or missing states prevent delivery.
 * The caller must separately enforce a stability window and current PR head.
 */
export function summarize(snapshot: Snapshot, attempts: readonly WorkflowAttempt[] = []): Result {
  if (attempts.some(a => a.state !== 'completed')) return { kind: 'pending' }
  if (!snapshot.checks.length && !snapshot.statuses.length) return { kind: 'pending' }
  if (snapshot.checks.some(c => c.status !== 'completed' || !c.conclusion) ||
      snapshot.statuses.some(s => !['success', 'failure', 'error'].includes(s.state))) return { kind: 'pending' }
  const failures = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure'])
  const neutral = new Set(['neutral', 'skipped'])
  if (snapshot.checks.some(c => c.conclusion !== 'success' && !failures.has(c.conclusion!) && !neutral.has(c.conclusion!))) return { kind: 'pending' }
  const failed = [...new Set([
    ...snapshot.checks.filter(c => failures.has(c.conclusion!)).map(c => c.name),
    ...snapshot.statuses.filter(s => s.state !== 'success').map(s => s.context),
  ])].sort()
  if (!failed.length && !snapshot.checks.some(c => c.conclusion === 'success') && !snapshot.statuses.some(s => s.state === 'success')) return { kind: 'pending' }
  const canonical = [
    ...snapshot.checks.map(c => ['check', c.id, c.name, c.status, c.conclusion]),
    ...snapshot.statuses.map(s => ['status', s.id, s.context, s.state]),
    ...attempts.map(a => ['workflow', a.runId, String(a.attempt)]),
  ].map(row => JSON.stringify(row)).sort()
  return { kind: 'complete', outcome: failed.length ? 'failure' : 'success', failed,
    fingerprint: createHash('sha256').update(JSON.stringify(canonical)).digest('hex') }
}
