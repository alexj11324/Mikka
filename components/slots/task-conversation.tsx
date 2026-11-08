// The default task-conversation slot (docs/ui-overlay.md): none. A thread opens alone, as it always has; a layer that
// keeps a task's attempts in one conversation exports a component here.
import type { ComponentType } from 'react'
import type { TaskConversationProps } from './task-conversation-contract'

export const TaskConversation: ComponentType<TaskConversationProps> | null = null
