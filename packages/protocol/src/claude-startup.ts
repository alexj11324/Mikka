// A bootstrap optimization hint, never an assignment or credential. It is
// consumed only beside the exact one-use bootstrap bytes and rechecked after claim.
import { z } from 'zod'
import { runPolicySchema } from './agent-policy'
import { runDecisionCatalogueSchema } from './device'
import { mailboxInputs } from './mailbox'

export const anonymousClaudeHintSchema = z.object({
  version: z.literal(1),
  runId: z.uuid(),
  bootstrapSha256: z.string().regex(/^[a-f0-9]{64}$/),
  profile: z.literal('cloud_repository_claude_v1'),
  model: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:/-]+$/),
  effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
  kind: z.enum(['implement', 'fix', 'plan']),
  github: z.boolean(),
  diagnostics: z.boolean(),
  policy: runPolicySchema,
  decisionCatalogue: runDecisionCatalogueSchema,
  mailboxTools: z.array(z.enum(Object.keys(mailboxInputs) as [keyof typeof mailboxInputs, ...Array<keyof typeof mailboxInputs>])).max(32)
    .refine(names => new Set(names).size === names.length, 'Duplicate mailbox metadata'),
}).strict()
export type AnonymousClaudeHint = z.infer<typeof anonymousClaudeHintSchema>
