import type { RunView } from './agent-runs'

/** A run's untyped transcript/report can echo a private prompt, memory or tool
 * output. Without trusted provenance it is owner-only. Share status, not the
 * private agent's identity or free-form text; never infer safety by redaction. */
export function workspaceRunView(run: RunView): RunView {
  return {
    id: run.id, issueId: run.issueId, agentId: '', agentName: run.harness,
    harness: run.harness, status: run.status, kind: 'implement',
    stopReason: null, error: null, report: null,
    createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt,
  }
}
