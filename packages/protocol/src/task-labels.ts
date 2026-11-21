/** Task label definitions belong to one workspace. Threads retain their own lifecycle metadata. */
export const TASK_LABEL_COLORS = ['violet', 'blue', 'green', 'yellow', 'red', 'gray'] as const
export type TaskLabelColor = (typeof TASK_LABEL_COLORS)[number]

export interface WorkspaceTaskLabel {
  id: string
  name: string
  color: TaskLabelColor
}

export interface WorkspaceTaskLabelsView {
  workspaceId: string
  source: 'workspace'
  labels: WorkspaceTaskLabel[]
  canManage: boolean
}

export interface CreateTaskLabelInput { name: string; color: TaskLabelColor }
export interface UpdateTaskLabelInput { name?: string; color?: TaskLabelColor }
export interface MergeTaskLabelsInput { targetId: string }
export interface TaskLabelReferencesInput { revision: number; labelIds: string[] }

/** Task metadata exposes IDs as its authority and keeps labels as a display snapshot for older clients. */
export interface TaskLabelReferences {
  labelIds: string[]
  labels: Array<Pick<WorkspaceTaskLabel, 'name' | 'color'>>
}
