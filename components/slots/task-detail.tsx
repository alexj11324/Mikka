// The default task-detail slot (docs/ui-overlay.md): none. A task's page keeps the community layout in
// components/workspace/task-detail.tsx; a layer that draws it exports a component here.
import type { ComponentType } from 'react'
import type { TaskDetailFrameProps } from './task-detail-contract'

export const TaskDetailFrame: ComponentType<TaskDetailFrameProps> | null = null
