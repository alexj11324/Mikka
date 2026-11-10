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
  line: EventLine | null
}

/**
 * The runs a person still has to answer for. A question is a live state, not a
 * stored transcript line: the chat shows one sentence above the composer and
 * draws no `runQuestion` row (decision 2026-11-10).
 *
 * - Only the latest non-stale `runQuestion` event counts.
 * - A readable run must still be `waiting_input` and unfinished; an unread
 *   source falls back to the event itself, so a slow lookup never hides it.
 * - One row per task (two threads of one task answer the same question), and
 *   the rows are oldest first, so the thread that has waited longest is first.
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
    if (run && (run.status !== 'waiting_input' || run.finishedAt)) continue
    const title = run ? runTitle(run) : line.title
    if (!title) continue
    rows.push({ runId: line.runId, title })
  }
  return rows.reverse()
}
