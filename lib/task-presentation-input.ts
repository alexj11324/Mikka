import { z } from 'zod'
import { TASK_PRESENTATION_BATCH_LIMIT } from './task-presentation-batch'

/** A transport bound for one visible list, never a limit on stored Tasks. */
export { TASK_PRESENTATION_BATCH_LIMIT }
export const taskPresentationsInput = z.strictObject({
  workspaceId: z.uuid(),
  issueIds: z.array(z.uuid()).max(TASK_PRESENTATION_BATCH_LIMIT),
  includeReview: z.literal(true).optional(),
  includeInboxReason: z.literal(true).optional(),
  includeBotDispatches: z.literal(true).optional(),
  includeFactoryIdentity: z.literal(true).optional(),
  /** Only the Artifacts overview asks for evidence counts beyond its local catalog. */
  folderStoredIds: z.array(z.uuid()).max(200).optional(),
})

export type TaskPresentationsInput = z.input<typeof taskPresentationsInput>
