import { z } from 'zod'
import { TASK_PRESENTATION_BATCH_LIMIT } from './task-presentation-batch'

/** A transport bound for one visible list, never a limit on stored Tasks. */
export { TASK_PRESENTATION_BATCH_LIMIT }
export const taskPresentationsInput = z.strictObject({
  workspaceId: z.uuid(),
  issueIds: z.array(z.uuid()).max(TASK_PRESENTATION_BATCH_LIMIT),
})

export type TaskPresentationsInput = z.input<typeof taskPresentationsInput>
