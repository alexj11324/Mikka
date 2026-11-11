// What the task-column slot receives (docs/ui-overlay.md): a task open in the
// right column beside the centre (decision 2026-11-07-2045). Its threads come
// from useIssueThreads (components/workspace/issue-threads.tsx); openThread,
// closeTask and toggleAllThreads (components/workspace/workspace-navigation.ts)
// move between it, its threads and the list it was opened from.
import type { ReactNode } from 'react'
import type { listIssues } from '@/app/actions/issues'
import type { Thread } from '@/app/actions/task-runs'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]

export type TaskColumnProps = {
  /** Shared TaskDetail with the workspace save guard. */
  children?: ReactNode
  issueId: string
  /** The task from the workspace's live task list; undefined when it is not in that list (older, or not loaded yet). */
  issue?: Issue
  /** Every thread in the workspace's live list; the task's own are those with its `issueId`. */
  threads: Thread[]
  /** Opened over 全部任务: ✕ closes both. */
  overList?: boolean
}
