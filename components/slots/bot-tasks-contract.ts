// What the bot-tasks slot receives (docs/ui-overlay.md): the body of a bot's
// panel tab that lists what it dispatched. The tasks come from
// hooks/use-bot-tasks.ts; the threads and tasks are the workspace's live lists.
import type { listIssues } from '@/app/actions/issues'
import type { Thread } from '@/app/actions/task-runs'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]

export type BotTasksProps = {
  /** Server-verified workspace and Bot whose dispatch history this panel reads. */
  workspaceId?: string
  botId?: string | null
  /** Where the list keeps its scroll and folded groups. */
  stateKey: string
  /** The threads this bot dispatched. */
  threads: Thread[]
  /** Those of them the panel search matches. */
  shown: Thread[]
  issues: Issue[]
  /** The panel search, or '' when it is closed. */
  query: string
  /** The thread list has not been read yet (review C7). */
  loading?: boolean
  /** A thread row opens that thread in the right column. */
  onOpenThread: (thread: { issueId: string | null; runId: string }) => void
  /** A task row opens that task in the right column (decision 2026-11-07-2045). */
  onOpenTask: (issueId: string) => void
}
