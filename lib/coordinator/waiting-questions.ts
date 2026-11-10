import { runTitle, type CitationSource } from './citations'
import type { EventLine } from './event-line'

export interface WaitingQuestionRun {
  /** The run to open; null when the event carried no readable run. */
  runId: string | null
  /** The thread's title without its task code (decision 2026-11-10-0659). */
  title: string
}

export interface WaitingQuestionItem {
  position: number
  line?: EventLine | null
}

/** Statuses that mean the task is already running a newer attempt: nothing waits on the person meanwhile. */
const ACTIVE = new Set(['queued', 'preparing', 'running', 'finishing'])
const CLOSED_ISSUE = new Set(['done', 'canceled', 'duplicate'])

/**
 * `needsReply` in `localTaskState`'s order (hooks/use-bot-tasks.ts): a closed
 * task, a newer active attempt, quota, a merged pull request, a failed run, or
 * a task waiting for review is not an answer the person owes. `asked_human`
 * sits where `needs_input` does: it is recorded when the run completes, before
 * the outcome judge answers. The inbox's factory-approval branch has no field
 * in `RunSource`, so it is not mirrored here.
 */
function needsReply(issue: { status?: string } | undefined, run: { status: string; outcome: string | null; stopReason?: string | null }, pullRequests: readonly { state: string }[]): boolean {
  const status = issue?.status
  if (status && CLOSED_ISSUE.has(status)) return false
  if (ACTIVE.has(run.status)) return false
  if (run.status === 'waiting_input') return true
  if (run.status === 'paused') return false
  if (pullRequests.some(pr => pr.state === 'merged')) return false
  if (run.outcome === 'failed' || run.outcome === 'blocked') return false
  if (status === 'review' || pullRequests.some(pr => pr.state === 'open' || pr.state === 'draft')) return false
  if (run.outcome === 'needs_input') return true
  // `asked_human` proves a question was asked, but a judged outcome still wins: done/idle/blocked means it moved on.
  if (run.outcome == null && run.stopReason === 'asked_human') return true
  return false
}

/**
 * The tasks a person still has to answer for. A question is a live state, not
 * a stored transcript line: the chat shows one sentence above the composer and
 * draws no `runQuestion` row (decision 2026-11-10).
 *
 * A `runQuestion` event only says a question was asked once. Whether the
 * person still owes an answer follows `localTaskState`/the inbox: a closed
 * task, a newer active attempt, quota, a merged pull request, a failed run or
 * a task waiting for review is not an answer owed; a live `waiting_input`, a
 * judged `needs_input`, or a run that ended `asked_human` is. Answering starts a continuation run on the same task, so the newest
 * run moves on and the sentence disappears.
 *
 * - Only the latest non-stale `runQuestion` event counts.
 * - One row per task (two threads of one task answer the same question), and
 *   the rows are oldest first, so the task that has waited longest is first.
 */
export function waitingQuestionRuns(
  items: readonly WaitingQuestionItem[],
  sources: Record<string, CitationSource> | undefined,
  stale: ReadonlySet<number>,
): WaitingQuestionRun[] {
  const seen = new Set<string>()
  const rows: WaitingQuestionRun[] = []
  for (const item of [...items].reverse()) {
    const line = item.line
    if (!line || line.kind !== 'runQuestion' || stale.has(item.position)) continue
    const source = line.runId ? sources?.[line.runId] : undefined
    const run = source?.kind === 'run' ? source : null
    const key = run?.issue?.id ?? line.runId ?? `position-${item.position}`
    if (seen.has(key)) continue
    seen.add(key)
    if (!run) continue
    // `runQuestion` prompts name the task (lib/coordinator/context.ts), so a real
    // question reads the task's newest run (`issue.run`, lib/issue-summary-columns)
    // — the same row the inbox reads. An issue exists but its newest run has not
    // loaded: wait for the next chat read rather than trust the asking run.
    const newest = run.issue ? run.issue.run : { status: run.status, outcome: run.outcome ?? null, stopReason: run.stopReason ?? null }
    if (!newest) continue
    // A thread with no task has no continuation the person can start (thread-continue refuses it), so only its
    // live wait can end on its own; an ended task-free question would otherwise stay forever.
    if (!run.issue) {
      if (newest.status === 'waiting_input') rows.push({ runId: line.runId, title: runTitle(run) })
      continue
    }
    if (!needsReply(run.issue, newest, run.pullRequests ?? [])) continue
    rows.push({ runId: line.runId, title: runTitle(run) })
  }
  return rows.reverse()
}

