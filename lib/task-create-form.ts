import type { CreateOnlyCommand } from './task-create-command'
import { TASK_TITLE_MAX } from './task-title-input'

/** The same person-entered text creates the same backlog item from either client. */
export function backlogTaskDraft(title: string, description: string): Pick<CreateOnlyCommand, 'title' | 'content' | 'status' | 'priority'> {
  const text = description.trim() || title.trim()
  return {
    title: title.trim() || text.split(/\r?\n/, 1)[0]!.slice(0, TASK_TITLE_MAX).trim(),
    content: { type: 'doc', content: text.split(/\r?\n/).map(line => ({
      type: 'paragraph', ...(line ? { content: [{ type: 'text', text: line }] } : {}),
    })) },
    status: 'todo', priority: 'normal',
  }
}

/** An acknowledged Eve message only needs its receipt read again. A lost send
 * response retries with the same identity and Eve resolves the original event. */
export async function acceptTaskDelivery(operation: { id: string; delivered?: true }, send: (id: string) => Promise<unknown>) {
  if (operation.delivered) return
  await send(operation.id)
  operation.delivered = true
}
