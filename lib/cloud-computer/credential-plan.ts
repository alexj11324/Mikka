import { createHash } from 'node:crypto'
import { z } from 'zod'

export const credentialPlanSchema = z.object({
  actionId: z.uuid(), workspaceId: z.uuid(), botId: z.uuid(), subagentId: z.uuid(),
  epoch: z.number().int().nonnegative(), permissionVersion: z.number().int().nonnegative(),
  targetId: z.string().min(1).max(200), origin: z.string().url(), loaderId: z.string().min(1).max(200),
  inputs: z.array(z.object({ backendNodeId: z.number().int().positive(), credentialRole: z.enum(['username', 'password']) }).strict()).min(1).max(2),
  operation: z.enum(['fill', 'submit', 'clear']), summary: z.string().min(1).max(500),
  expiresAt: z.number().int().positive(), submittedUsername: z.string().max(255).optional(), forcePassword: z.boolean().optional(),
}).strict().refine(value => {
  try { const url = new URL(value.origin); return url.protocol === 'https:' && url.origin === value.origin && !url.username && !url.password && new Set(value.inputs.map(item => item.credentialRole)).size === value.inputs.length && value.inputs.some(item => item.credentialRole === 'password') } catch { return false }
})
export type CredentialPlan = z.infer<typeof credentialPlanSchema>
export function credentialPlanDigest(userId: string, value: CredentialPlan) {
  return createHash('sha256').update(JSON.stringify([userId, credentialPlanSchema.parse(value)])).digest('hex')
}
export function credentialReviewSummary(operation: CredentialPlan['operation'], origin: string) {
  return operation === 'fill' ? `Enter the saved login at ${origin} without submitting` : operation === 'submit' ? `Submit the entered login at ${origin}` : `Clear the entered login at ${origin} and resume only when safe`
}
