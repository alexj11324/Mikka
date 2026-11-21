import { z } from 'zod'
import { TASK_LABEL_COLORS } from '@mikka/protocol/task-labels'

const name = z.string().trim().min(1).max(40)
export const createTaskLabelInput = z.strictObject({ name, color: z.enum(TASK_LABEL_COLORS) })
export const updateTaskLabelInput = createTaskLabelInput.partial().refine(value => Object.keys(value).length>0)
export const mergeTaskLabelsInput = z.strictObject({ targetId: z.uuid() })
export const taskLabelReferencesInput = z.strictObject({ revision: z.number().int().positive(), labelIds: z.array(z.uuid()).max(12) })
