import { z } from 'zod'

/** The model picks the observed login target, never code or a secret. */
export const credentialIntentSchema = z.object({
  targetSelector: z.string().regex(/^\[data-mikka-ref="(?:0|[1-9]\d{0,2})"\]$/),
}).strict()
export type CredentialIntent = z.infer<typeof credentialIntentSchema>

export function credentialStep(status: 'needs_login' | 'session_applied' | 'submitted'): 'waiting' | 'running' {
  return status === 'needs_login' ? 'waiting' : 'running'
}
