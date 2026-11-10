// The default new-task slot (docs/ui-overlay.md): none. NewTaskDialog draws its own dialog; a layer that draws
// 新建任务 in its own window exports a component here.
import type { ComponentType } from 'react'
import type { NewTaskProps } from './new-task-contract'

export const NewTask: ComponentType<NewTaskProps> | null = null
