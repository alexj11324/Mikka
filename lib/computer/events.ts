import { z } from 'zod'

const computerEvent = z.object({
  type: z.literal('data-computer'),
  data: z.object({ botId: z.uuid(), runId: z.uuid(), task: z.string().trim().min(1).max(200), state: z.literal('working') }).strict(),
}).strict()

/** Only the server-bound Bot may be named by a run's computer event. */
export function computerEventsMatch(chunks: readonly Record<string, unknown>[], runId: string, botId: string | null) {
  return chunks.filter(chunk => chunk.type === 'data-computer').every(chunk => {
    const parsed = computerEvent.safeParse(chunk)
    return parsed.success && parsed.data.data.runId === runId && parsed.data.data.botId === botId
  })
}
