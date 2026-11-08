import { z } from 'zod'
import { anonymousClaudeHintSchema } from './claude-startup'
export const anonymousCodexHintSchema = anonymousClaudeHintSchema.omit({ profile: true, effort: true }).extend({
  profile: z.literal('cloud_repository_codex_0166_v1'),
  effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
}).strict()
export type AnonymousCodexHint = z.infer<typeof anonymousCodexHintSchema>
