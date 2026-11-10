import { z } from 'zod'
import { withBasePath } from './base-path'
import { executionIdentityLabelsSchema } from './execution-identity-label-view'
import { profileColorSchema, profileGlyphSchema } from './factory/agent-profile-mark'
import { MODEL_ROUTING_DIFFICULTIES, MODEL_ROUTING_EFFORTS, MODEL_ROUTING_REASONS, MODEL_ROUTING_TIERS } from './model-routing'

/** Shared allowlist for the server evidence projection and its client reader. */
const frozenRouting = {
  model: z.string().min(1).max(200),
  harness: z.enum(['claude_code', 'codex']),
  tier: z.enum(MODEL_ROUTING_TIERS),
  effort: z.enum(MODEL_ROUTING_EFFORTS).optional(),
  reason: z.enum(MODEL_ROUTING_REASONS),
  previousModel: z.string().min(1).max(200).optional(),
}
export const modelRoutingEvidenceSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), difficulty: z.enum([...MODEL_ROUTING_DIFFICULTIES, 'unknown']), ...frozenRouting }).strip(),
  z.object({ version: z.literal(2), required: z.enum([...MODEL_ROUTING_TIERS, 'unknown']), ...frozenRouting }).strip(),
])

const reference = z.string().min(1).max(200)
const resource = z.object({
  kind: z.enum(['device', 'api_key', 'subscription', 'e2b', 'mcp']),
  id: reference, ownerId: reference, access: z.enum(['owner', 'workspace_share']),
  revision: z.string().max(200).optional(),
})
const account = z.object({
  kind: z.enum(['api_key', 'subscription', 'native_login', 'local_device', 'e2b']),
  ownerId: reference, resourceId: reference,
  amount: z.enum(['provider_unknown', 'metered', 'not_applicable']),
})
const identity = z.object({
  version: z.literal(1), requester: reference, botId: z.uuid().nullable(), botOwner: reference.nullable(),
  executionPrincipal: reference, workspaceId: z.uuid().nullable(), outputOwner: reference,
  resourceBindings: z.array(resource), billingAccount: z.object({ model: account, runtime: account }),
  personalResourcePolicy: z.literal('requester_only'),
})
const evidence = z.object({ run: z.object({
  id: z.uuid(), harness: z.string().max(200).nullable(), model: z.string().max(200).nullable(),
  credentialType: z.enum(['subscription', 'api_key', 'unknown']),
  subscriptionRoute: z.enum(['claude_code_cli', 'codex_cli']).nullable().catch(null),
  executionIdentity: identity.nullable(),
  labels: executionIdentityLabelsSchema.nullable().optional().catch(null),
  modelRouting: modelRoutingEvidenceSchema.nullable().optional().catch(null),
  agentProfile: z.object({
    profileId: z.string().min(1).max(200), name: z.string().max(80), version: z.number().int().positive(), digest: z.string().max(200),
    source: z.enum(['explicit', 'decision', 'default']), reason: z.string().max(4000),
    // Presentation only; an older server or an unknown id leaves the dialog to derive it.
    icon: profileGlyphSchema.optional().catch(undefined), color: profileColorSchema.optional().catch(undefined),
  }).nullable().optional(),
}) })

/** Presentation-only allowlist over the existing owner evidence API. Never
 * infer a frozen account from a Bot's current model settings. */
export type ThreadExecutionEvidence = z.infer<typeof evidence>['run']
export function threadExecutionEvidence(input: unknown, runId: string): ThreadExecutionEvidence {
  const parsed = evidence.safeParse(input)
  if (!parsed.success || parsed.data.run.id !== runId) throw Error('thread_execution_evidence_unavailable')
  return parsed.data.run
}

/** Also guard the rendered value during a run-key change or late response. */
export function currentThreadExecutionEvidence(data: ThreadExecutionEvidence | undefined, runId: string) {
  return data?.id === runId ? data : null
}

export async function readThreadExecutionEvidence(runId: string, fetchImpl: typeof fetch = fetch): Promise<ThreadExecutionEvidence> {
  if (!z.uuid().safeParse(runId).success) throw Error('thread_execution_evidence_unavailable')
  const response = await fetchImpl(withBasePath(`/api/runs/${runId}/evidence`), {
    method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw Error('thread_execution_evidence_unavailable')
  return threadExecutionEvidence(await response.json(), runId)
}
