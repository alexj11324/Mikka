import { z } from 'zod'

export const scheduleChatResultSchema = z.object({
  version: z.literal(1),
  title: z.string().max(200),
  status: z.enum(['succeeded', 'failed', 'skipped', 'cancelled']),
  task: z.object({ id: z.uuid(), title: z.string(), status: z.string() }).optional(),
})
export type ScheduleChatResult = z.infer<typeof scheduleChatResultSchema>

/** Only the result belongs in the reply. Execution identifiers stay in schedule history. */
export function scheduleChatMessage(title: string, status: string, result: unknown) {
  const task = z.object({ id: z.uuid(), title: z.string(), status: z.string() }).safeParse(result)
  const marker = scheduleChatResultSchema.parse({ version: 1, title, status, ...(task.success ? { task: task.data } : {}) })
  const text = result && typeof result === 'object' && 'text' in result && typeof result.text === 'string' ? result.text : ''
  return { role: 'assistant' as const, content: text, mikkaScheduleResult: marker }
}
