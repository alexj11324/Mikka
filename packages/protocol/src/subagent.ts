import { z } from 'zod'
export const subagentStatusSchema = z.enum(['queued', 'running', 'needs_you', 'done', 'failed', 'stopped'])
export const subagentNeedsSchema = z.union([
  z.object({ kind: z.enum(['login', 'code']), site: z.string().min(1).max(255), account: z.string().max(255).optional() }).strict(),
  z.object({ kind: z.literal('approval'), actionId: z.uuid(), summary: z.string().max(500) }).strict(),
])
export const subagentEventSchema = z.object({
  type: z.literal('data-subagent'),
  data: z.object({ botId: z.uuid(), subagentId: z.uuid(), task: z.string().min(1).max(2000), state: subagentStatusSchema, step: z.string().max(500), needs: subagentNeedsSchema.nullable() }).strict(),
}).strict()
export type SubagentEvent = z.infer<typeof subagentEventSchema>
export const startSubagentSchema = z.object({ task: z.string().trim().min(1).max(2000) }).strict()
