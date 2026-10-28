import { z } from 'zod'

/** The model picks an observed element and purpose, never code or a secret. */
export const credentialIntentSchema = z.object({
  action: z.enum(['restore_session', 'fill_login', 'submit_login']),
  targetSelector: z.string().regex(/^\[data-mikka-ref="(?:0|[1-9]\d{0,2})"\]$/),
}).strict()
export type CredentialIntent = z.infer<typeof credentialIntentSchema>

export function credentialStep(status: 'needs_login' | 'session_applied' | 'submitted'): 'waiting' | 'running' {
  return status === 'needs_login' ? 'waiting' : 'running'
}
