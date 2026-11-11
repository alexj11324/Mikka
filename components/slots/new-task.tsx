// Official clients supply the creation window through this contract. The server can build without a renderer.
import type { ComponentType } from 'react'
import type { NewTaskProps } from './new-task-contract'

export const NewTask: ComponentType<NewTaskProps> | null = null
