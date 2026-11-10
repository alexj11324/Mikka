// What the tasks slot receives (docs/ui-overlay.md): the 任务 page's body
// (`?section=tasks`). The threads and tasks are the workspace's live lists.
import type { listIssues } from '@/app/actions/issues'
import type { Thread } from '@/app/actions/task-runs'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]

export type TasksPageProps = {
  threads: Thread[]
  issues: Issue[]
  /** Opens a task's own page: its conversation, review and acceptance, every field. */
  onOpenIssue: (id: string) => void
  /** 新建任务. */
  onCreate: () => void
  /** 收件箱, where what a task waits on is answered. */
  onOpenInbox: () => void
}
