import { createHash } from 'node:crypto'
import type { WorkflowAttempt } from './attempts'

/** The provider response must be complete and paginated before calling this function. */
export type Check = { id: string; name: string; status: string; conclusion: string | null; appId?: number | null; suiteId?: string | null }
export type CommitStatus = { context: string; state: string; id: string }
export type WorkflowRun = { id: string; attempt: number; name: string; status: string; conclusion: string | null; workflowId?: string; event?: string; createdAt?: string; suiteId?: string | null }
export type RequiredCheck = { context: string; appId: number | null }
export type Snapshot = { checks: Check[]; statuses: CommitStatus[]; workflows?: WorkflowRun[]; requiredChecks?: RequiredCheck[]; unknownRequiredWorkflow?: boolean }
export type Result = { kind: 'pending'; reason?: 'required_check_missing' | 'ambiguous_workflow_order' } | { kind: 'complete'; outcome: 'success' | 'failure'; failed: string[]; fingerprint: string }

/**
 * Cancelled, timed-out, action-required and failed checks are failures.
 * Neutral/skipped checks are not failures but cannot alone establish success.
 * Unknown or missing states prevent delivery.
 * The caller must separately enforce a stability window and current PR head.
 */
export function summarize(snapshot: Snapshot, attempts: readonly WorkflowAttempt[] = []): Result {
  if (snapshot.unknownRequiredWorkflow || snapshot.workflows?.some(run => run.status !== 'completed' || !run.conclusion)) return { kind: 'pending' }
  if (attempts.some(a => a.state !== 'completed')) return { kind: 'pending' }
  const latestRuns = new Map<string, WorkflowRun>()
  for (const run of snapshot.workflows ?? []) {
    const key = run.workflowId && run.event ? `${run.workflowId}:${run.event}` : run.id
    const previous = latestRuns.get(key)
    if (!previous || (run.createdAt ?? '') > (previous.createdAt ?? '') || ((run.createdAt ?? '') === (previous.createdAt ?? '') && BigInt(run.id) > BigInt(previous.id))) latestRuns.set(key, run)
  }
  if ((snapshot.workflows ?? []).some(run => run.workflowId && run.event && run.attempt > 1 && latestRuns.get(`${run.workflowId}:${run.event}`)?.id !== run.id)) return { kind: 'pending', reason: 'ambiguous_workflow_order' }
  const currentSuites = new Set([...latestRuns.values()].flatMap(run => run.suiteId ? [run.suiteId] : []))
  const oldSuites = new Set((snapshot.workflows ?? []).flatMap(run => run.suiteId && !currentSuites.has(run.suiteId) ? [run.suiteId] : []))
  const checks = snapshot.checks.filter(check => !check.suiteId || !oldSuites.has(check.suiteId))
  if (snapshot.requiredChecks?.some(required => !checks.some(check => check.name === required.context && (required.appId === null || check.appId === required.appId)) && !(required.appId === null && snapshot.statuses.some(status => status.context === required.context)))) return { kind: 'pending', reason: 'required_check_missing' }
  if (!checks.length && !snapshot.statuses.length) return { kind: 'pending' }
  if (checks.some(c => c.status !== 'completed' || !c.conclusion) ||
      snapshot.statuses.some(s => !['success', 'failure', 'error'].includes(s.state))) return { kind: 'pending' }
  const failures = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure'])
  const neutral = new Set(['neutral', 'skipped'])
  if (checks.some(c => c.conclusion !== 'success' && !failures.has(c.conclusion!) && !neutral.has(c.conclusion!))) return { kind: 'pending' }
  if ([...latestRuns.values()].some(w => w.conclusion !== 'success' && !failures.has(w.conclusion!) && !neutral.has(w.conclusion!))) return { kind: 'pending' }
  const failed = [...new Set([
    ...[...latestRuns.values()].filter(w => failures.has(w.conclusion!)).map(w => w.name),
    ...checks.filter(c => failures.has(c.conclusion!)).map(c => c.name),
    ...snapshot.statuses.filter(s => s.state !== 'success').map(s => s.context),
  ])].sort()
  if (!failed.length && !checks.some(c => c.conclusion === 'success') && !snapshot.statuses.some(s => s.state === 'success')) return { kind: 'pending' }
  const canonical = [
    ...checks.map(c => ['check', c.id, c.name, c.status, c.conclusion, c.appId ?? null]),
    ...(snapshot.workflows ?? []).map(w => ['workflow-run', w.id, String(w.attempt), w.name, w.status, w.conclusion]),
    ...(snapshot.requiredChecks ?? []).map(c => ['required', c.context, String(c.appId)]),
    ...snapshot.statuses.map(s => ['status', s.id, s.context, s.state]),
    ...attempts.map(a => ['workflow', a.runId, String(a.attempt)]),
  ].map(row => JSON.stringify(row)).sort()
  return { kind: 'complete', outcome: failed.length ? 'failure' : 'success', failed,
    fingerprint: createHash('sha256').update(JSON.stringify(canonical)).digest('hex') }
}
