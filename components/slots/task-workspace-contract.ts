import type { ReactNode } from 'react'

/** The workspace a task belongs to, as the account menu reports it. */
export type TaskWorkspaceInfo = { id: string; name: string; kind: string }

export type TaskWorkspaceProps = {
  /**
   * The workspace, or null while it loads or when the task is not in the
   * workspace currently shown (another tab switched).
   */
  workspace: TaskWorkspaceInfo | null
  /**
   * `create`: the new-task dialog's first pill, naming the workspace the task
   * will be created in. `detail`: the task's properties, showing where it is fixed.
   */
  variant: 'create' | 'detail'
  /** Detail only: wraps a value in the properties list's own labelled row. */
  row?: (label: string, value: ReactNode) => ReactNode
}
