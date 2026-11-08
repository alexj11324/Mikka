// What the all-threads slot receives (docs/ui-overlay.md): the window bar's
// button for what every bot dispatched, and the right column it opens.
import type { listIssues } from '@/app/actions/issues'
import type { Thread } from '@/app/actions/task-runs'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]

export type AllThreadsToggleProps = {
  open: boolean
  onToggle: () => void
  /** Threads in 等待你 (R-52). */
  waiting?: number
  /** Tasks in 待处理 (decision 2026-11-07-2045), for a layer that lists tasks. */
  pending?: number
}

export type AllThreadsColumnProps = {
  /** 'all', or the id of the one bot it is filtered to. */
  view: string
  /** Every thread the person's bots dispatched. */
  threads: Thread[]
  issues: Issue[]
  /** Not read yet (review C7). */
  loading?: boolean
}
