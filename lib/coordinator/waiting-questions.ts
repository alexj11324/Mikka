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

/**
 * The tasks a person still has to answer for. A question is a live state, not
 * a stored transcript line: the chat shows one sentence above the composer and
 * draws no `runQuestion` row (decision 2026-11-10).
 *
 * A `runQuestion` event only says a question was asked once. Whether it is
 * still waiting follows the same rule as the inbox and the thread's 等待你
 * badge: the task's newest run is `waiting_input`, or ended and judged
 * `needs_input`. Answering starts a continuation run on the same task, so the
 * newest run moves on and the sentence disappears.
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
    // `issue.run` is the task's newest run (lib/issue-summary-columns): the same
    // row the inbox reads, so the sentence and needsReply cannot disagree.
    const newest = run ? run.issue?.run ?? { status: run.status, outcome: run.outcome ?? null } : null
    if (!run || !newest) continue
    if (newest.status !== 'waiting_input' && !(newest.status === 'stopped' && newest.outcome === 'needs_input')) continue
    rows.push({ runId: line.runId, title: runTitle(run) })
  }
  return rows.reverse()
}
