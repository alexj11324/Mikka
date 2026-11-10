import { z } from 'zod'

/** Source order is a preference, never a resource grant or permission to charge. */
export const modelSourceSchema = z.enum(['personal_subscription', 'personal_api_key', 'organization', 'shared_api_key'])
export type ModelSource = z.infer<typeof modelSourceSchema>
const modelRule = z.object({
  mode: z.enum(['allow', 'disabled', 'organization_only']),
  connectionId: z.uuid().optional(),
}).strict().refine(rule => !rule.connectionId || rule.mode === 'organization_only', 'connection_requires_organization_only')
export const organizationModelPolicySchema = z.object({
  sourceOrder: z.array(modelSourceSchema).length(4).refine(order => new Set(order).size === 4),
  models: z.record(z.string().min(1).max(128), modelRule).refine(rules => Object.keys(rules).length <= 200),
  /** An exhausted connection can use another connection of the SAME payer and model only after explicit opt-in. */
  paidFallback: z.enum(['deny', 'same_payer']),
  /** Explicit organization-funded collaborative replies. Unknown external
   * dollars stay unknown; these are hard capacity limits, not a price quote. */
  sharedChat: z.object({
    maxModelCallsPerTurn: z.number().int().min(1).max(64),
    maxRepliesPerDay: z.number().int().min(1).max(10000),
    maxOutputTokens: z.number().int().min(64).max(16384),
  }).strict().optional(),
}).strict()
export type OrganizationModelPolicy = z.infer<typeof organizationModelPolicySchema>
export const DEFAULT_ORGANIZATION_MODEL_POLICY: OrganizationModelPolicy = {
  sourceOrder: ['personal_subscription', 'personal_api_key', 'organization', 'shared_api_key'], models: {}, paidFallback: 'deny',
}

export function readModelPolicy(value: unknown): OrganizationModelPolicy {
  if (value === null || value === undefined) return DEFAULT_ORGANIZATION_MODEL_POLICY
  // A corrupt persisted policy fails closed instead of silently allowing every model.
  return organizationModelPolicySchema.parse(value)
}
export function organizationModelAllowed(policy: OrganizationModelPolicy, model: string, source: ModelSource, connectionId?: string) {
  const rules = [policy.models['*'], policy.models[model]].filter(rule => rule !== undefined)
  return rules.every(rule => rule.mode !== 'disabled' && (rule.mode !== 'organization_only'
    || source === 'organization' && (!rule.connectionId || rule.connectionId === connectionId)))
}

/** Hosted collaboration needs a deliberate organization connection rule. A
 * member's right to read or edit a Bot is never permission to use its owner's resources. */
export function organizationCollaboratorModelAllowed(policy: OrganizationModelPolicy, model: string, connectionId: string) {
  return organizationModelAllowed(policy, model, 'organization', connectionId)
    && [policy.models['*'], policy.models[model]].some(rule => rule?.mode === 'organization_only' && rule.connectionId === connectionId)
}

export const organizationCredentialOwner = (organizationId: string) => `organization:${z.uuid().parse(organizationId)}`
