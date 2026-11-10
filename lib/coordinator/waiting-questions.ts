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

/** Statuses that mean the task has a newer run doing something: nothing waits on the person meanwhile. */
const ACTIVE = new Set(['queued', 'preparing', 'running', 'finishing', 'paused'])
const CLOSED_ISSUE = new Set(['done', 'canceled', 'duplicate'])

/** A run that ended on a question asked the person: `asked_human` is recorded at completion, before the outcome judge answers. */
function waitsOnPerson(run: { status: string; outcome: string | null; stopReason?: string | null }): boolean {
  if (run.status === 'waiting_input') return true
  if (ACTIVE.has(run.status)) return false
  return run.outcome === 'needs_input' || run.stopReason === 'asked_human'
}

/**
 * The tasks a person still has to answer for. A question is a live state, not
 * a stored transcript line: the chat shows one sentence above the composer and
 * draws no `runQuestion` row (decision 2026-11-10).
 *
 * A `runQuestion` event only says a question was asked once. Whether it is
 * still waiting follows the inbox's order (lib/inbox/store.ts): a closed task
 * or a merged pull request is not waiting; an active newest run is not waiting;
 * a live `waiting_input`, a judged `needs_input`, or a `stopped/asked_human`
 * run is. Answering starts a continuation run on the same task, so the newest
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
    if (run.issue?.status && CLOSED_ISSUE.has(run.issue.status)) continue
    if ((run.pullRequests ?? []).some(pr => pr.state === 'merged')) continue
    if (!waitsOnPerson(newest)) continue
    rows.push({ runId: line.runId, title: runTitle(run) })
  }
  return rows.reverse()
}

