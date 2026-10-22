import type { RunReport } from '@mikka/protocol/run'
import type { CoordinatorEventKind, RunStatus } from '@/lib/db/schema'

/** One row for `coordinator_events`, before it gets an id. */
export interface CoordinatorEventInput {
  userId: string
  kind: CoordinatorEventKind
  dedupeKey: string
  issueId: string | null
  runId: string | null
  payload: Record<string, unknown>
}

/** A message the person wrote to their Coordinator. */
export function userMessageEvent(userId: string, text: string): CoordinatorEventInput {
  const id = crypto.randomUUID()
  return { userId, kind: 'user_message', dedupeKey: `user_message:${id}`, issueId: null, runId: null, payload: { text } }
}

/** A run ended. One event per run, however often the daemon reports it. */
export function runFinishedEvent(run: { id: string; userId: string; issueId: string | null; kind: string; status: RunStatus; stopReason: string; report?: RunReport | null }): CoordinatorEventInput {
  return {
    userId: run.userId,
    kind: 'run_finished',
    dedupeKey: `run_finished:${run.id}`,
    issueId: run.issueId,
    runId: run.id,
    payload: { status: run.status, stopReason: run.stopReason, runKind: run.kind, summary: run.report?.summary ?? null },
  }
}

/**
 * An issue moved to done, or null when this save is not that move. Keyed by
 * the revision that made the move, so reopening and finishing again is a new
 * event.
 */
export function issueDoneEvent(before: { status: string }, after: { id: string; userId: string; title: string; status: string; revision: number }): CoordinatorEventInput | null {
  if (before.status === 'done' || after.status !== 'done') return null
  return {
    userId: after.userId,
    kind: 'issue_done',
    dedupeKey: `issue_done:${after.id}:${after.revision}`,
    issueId: after.id,
    runId: null,
    payload: { title: after.title, previousStatus: before.status },
  }
}
