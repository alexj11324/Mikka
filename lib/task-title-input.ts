import { z } from 'zod'

/** The most characters a title the person types in the New task form may have: what a task's short title column holds. */
export const TASK_TITLE_MAX = 60

/** A title typed in the New task form: one line, trimmed, 1 to TASK_TITLE_MAX characters. */
export const taskTitleInputSchema = z.string().trim().min(1).max(TASK_TITLE_MAX).refine(value => !/[\r\n]/.test(value))
