import { z } from 'zod'

/** A transport bound for one visible list, never a limit on stored Tasks. */
export const TASK_PRESENTATION_BATCH_LIMIT = 200
export const taskPresentationsInput = z.strictObject({
  workspaceId: z.uuid(),
  issueIds: z.array(z.uuid()).max(TASK_PRESENTATION_BATCH_LIMIT),
})

export type TaskPresentationsInput = z.input<typeof taskPresentationsInput>
