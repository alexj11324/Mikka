import { createHash } from 'node:crypto'
import { z } from 'zod'

/** The installed Gateway SDK's server-owned transport, not a client proxy URL. */
export const GATEWAY_MODEL_ENDPOINT = 'https://ai-gateway.vercel.sh/v4/ai'
const modelId = z.string().max(128).regex(/^[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9._:-]*$/).refine(value => value === value.trim())
const providerId = z.string().max(80).regex(/^[a-z0-9][a-z0-9-]*$/).refine(value => value === value.trim())
export const modelAdmissionPolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  revoked: z.boolean().default(false),
  routes: z.array(z.strictObject({
    provider: z.literal('vercel-gateway'),
    endpoint: z.literal(GATEWAY_MODEL_ENDPOINT),
    model: modelId,
    servingProviders: z.array(providerId).min(1).max(20),
    /** Omission means any currently active member, never an anonymous caller. */
    principalIds: z.array(z.string().min(1).max(200)).min(1).max(100).optional(),
    /** No current Gateway response proves a data region. Unknown is explicit. */
    dataRegions: z.array(z.enum(['unknown', 'us', 'eu'])).min(1).max(3),
  })).max(100),
})
export type ModelAdmissionPolicy = z.infer<typeof modelAdmissionPolicySchema>
export type ModelAdmissionCode = 'modelRouteDenied' | 'modelPolicyRevoked' | 'modelRegionUnverified' | 'modelPrincipalUnavailable' | 'modelPolicyChanged' | 'modelPolicyInvalid' | 'modelTransportActive'
export class ModelAdmissionError extends Error {
  constructor(readonly code: ModelAdmissionCode) { super(code); this.name = 'ModelAdmissionError' }
}
export function parseModelAdmissionPolicy(value: unknown): ModelAdmissionPolicy {
  const parsed = modelAdmissionPolicySchema.safeParse(value)
  if (!parsed.success) throw new ModelAdmissionError('modelPolicyInvalid')
  return parsed.data
}
export function modelAdmissionRevision(policy: ModelAdmissionPolicy | null): string {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex')
}
export interface GatewayAdmission {
  model: string
  endpoint: typeof GATEWAY_MODEL_ENDPOINT
  servingProviders: string[]
  dataRegion: 'unknown'
}
export function admitGatewayRoute(policy: ModelAdmissionPolicy, request: {
  ownerId: string | null
  model: string
  endpoint: string
}): GatewayAdmission {
  if (policy.revoked) throw new ModelAdmissionError('modelPolicyRevoked')
  if (!request.ownerId) throw new ModelAdmissionError('modelPrincipalUnavailable')
  const routes = policy.routes.filter(route => route.model === request.model && route.endpoint === request.endpoint &&
    (!route.principalIds || route.principalIds.includes(request.ownerId!)))
  if (!routes.length) throw new ModelAdmissionError('modelRouteDenied')
  const allowed = routes.filter(route => route.dataRegions.includes('unknown'))
  if (!allowed.length) throw new ModelAdmissionError('modelRegionUnverified')
  return { model: request.model, endpoint: GATEWAY_MODEL_ENDPOINT,
    servingProviders: [...new Set(allowed.flatMap(route => route.servingProviders))].sort(), dataRegion: 'unknown' }
}

/** Caller-supplied fallback/BYOK/order options cannot broaden a managed route. */
export function managedGatewayOptions(admission: GatewayAdmission) {
  return { only: admission.servingProviders, order: admission.servingProviders, models: [] }
}
