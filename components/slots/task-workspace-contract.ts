import type { ReactNode } from 'react'
import type { TaskWorkspaceInfo, TaskWorkspaceState } from '@/lib/task-workspace-state'

export type { TaskWorkspaceInfo, TaskWorkspaceState }

export type TaskWorkspaceProps = {
  /**
   * The workspace when `state` is `ready`, otherwise null (loading, a read
   * error, or the task's workspace is not the one currently shown).
   */
  workspace: TaskWorkspaceInfo | null
  /**
   * Loading, request error and workspace mismatch kept apart
   * (lib/task-workspace-state.ts). `create`: the dialog's workspace against
   * the confirmed current one; `detail`: the task's persisted workspace
   * against the current one.
   */
  state: TaskWorkspaceState
  /** Reads the current workspace again; offered with the `error` state. */
  onRetry?: () => void
  /**
   * `create`: the new-task dialog's first pill, naming the workspace the task
   * will be created in. `detail`: the task's properties, showing where it is fixed.
   */
  variant: 'create' | 'detail'
  /** Detail only: the workspace id the task was created in (persisted; null from an older server). */
  workspaceId?: string | null
  /** Detail only: wraps a value in the properties list's own labelled row. */
  row?: (label: string, value: ReactNode) => ReactNode
}
