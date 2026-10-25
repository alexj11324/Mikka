import { z } from 'zod'

export const createCredentialRequestSchema = z.object({
  workspaceId: z.uuid(), runId: z.uuid(),
  serviceId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  mode: z.enum(['api_header', 'browser_login']),
}).strict()

// Only this body carries a secret. Never pass it to logging, tracing, events or a model.
export const submitCredentialSchema = z.object({
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  secret: z.string().min(1).max(8192).refine(s => !/[\r\n\0]/.test(s)),
  save: z.boolean().default(false),
}).strict()

export type CredentialState = 'pending' | 'submitting' | 'ready' | 'using' | 'active_session' | 'consumed' | 'cancelled' | 'expired' | 'failed' | 'disconnected' | 'handoff_required'
export type Principal = { ownerId: string; authSessionId: string }
const browserActionId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)
export const browserTaskActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('navigate'), pageId: browserActionId }).strict(),
  z.object({ type: z.literal('read'), regionId: browserActionId }).strict(),
  z.object({ type: z.literal('click'), targetId: browserActionId }).strict(),
])
export type BrowserTaskAction = z.infer<typeof browserTaskActionSchema>
export type Binding = {
  ownerId: string; workspaceId: string; taskId: string; runId: string;
  executionSession: string; authSessionId: string
}
export type CredentialView = {
  id: string; credentialRef: string; serviceId: string; targetOrigin: string;
  mode: 'api_header' | 'browser_login'; state: CredentialState;
  retention: 'once' | 'session'; expiresAt: string; useExpiresAt: string | null;
  cleanupPending: boolean; version: number
}

export class CredentialError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}
export function denied(): never { throw new CredentialError('credential_not_found', 404) }
