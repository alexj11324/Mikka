import type { TaskConversationProps } from './task-conversation-contract'

/** The official renderer provides this required slot. Server builds need only its contract. */
export function TaskConversation(_props: TaskConversationProps): never {
  throw new Error('Required official UI slot task-conversation.TaskConversation is unavailable')
}
