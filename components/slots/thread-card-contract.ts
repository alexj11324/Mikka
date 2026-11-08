// What the thread-card slot receives (docs/ui-overlay.md): a thread a reply
// dispatched, as the chat shows it under that reply.
import type { RunSource } from '@/lib/coordinator/citations'

export type ThreadCardProps = {
  run: RunSource
  /** Opens the thread in the right column. */
  onOpen: (thread: { issueId: string | null; runId: string }) => void
  /** Opens its task in the right column (decision 2026-11-07-2045), for a layer whose card is the task's. */
  onOpenTask?: (issueId: string) => void
}
