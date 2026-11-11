import { createHash } from 'node:crypto'
import { z } from 'zod'

/** The installed Gateway SDK's server-owned transport, not a client proxy URL. */
export const GATEWAY_MODEL_ENDPOINT = 'https://ai-gateway.vercel.sh/v4/ai'
/** ZeroCat's OpenAI-compatible API, which serves the default model (lib/abuse/zerocat.ts). */
export const ZEROCAT_MODEL_ENDPOINT = 'https://zero.cat/v1'
// These are the existing private Go worker's fixed destinations, not supplied
// by a binding, CLI or HTTP caller. Neither transport follows redirects.
export const CODEX_SUBSCRIPTION_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'
export const CLAUDE_SUBSCRIPTION_ENDPOINT = 'https://api.anthropic.com/v1/messages'
const modelId = z.string().max(128).regex(/^[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9._:-]*$/).refine(value => value === value.trim())
const providerId = z.string().max(80).regex(/^[a-z0-9][a-z0-9-]*$/).refine(value => value === value.trim())
const routeScope = {
  principalIds: z.array(z.string().min(1).max(200)).min(1).max(100).optional(),
  dataRegions: z.array(z.enum(['unknown', 'us', 'eu'])).min(1).max(3),
}
const subscriptionModelId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/)
export const modelAdmissionPolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  revoked: z.boolean().default(false),
  routes: z.array(z.discriminatedUnion('provider', [z.strictObject({
    provider: z.literal('vercel-gateway'),
    endpoint: z.literal(GATEWAY_MODEL_ENDPOINT),
    model: modelId,
    // One physical serving route: no hidden provider fallback inside Gateway.
    servingProviders: z.array(providerId).length(1),
    ...routeScope,
  }), z.strictObject({
    provider: z.literal('zerocat'), endpoint: z.literal(ZEROCAT_MODEL_ENDPOINT),
    model: modelId, servingProviders: z.tuple([z.literal('zerocat')]), ...routeScope,
  }), z.strictObject({
    provider: z.literal('cloudflare-workers-ai'),
    endpoint: z.string().regex(/^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[a-f0-9]{32}\/ai\/v1$/),
    model: z.literal('deepseek/deepseek-v4.1-flash'), servingProviders: z.tuple([z.literal('cloudflare-workers-ai')]), ...routeScope,
  }), z.strictObject({
    provider: z.literal('openai-compatible'),
    endpoint: z.url().refine(value => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && !value.endsWith('/') }),
    model: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/), servingProviders: z.tuple([z.literal('openai-compatible')]), ...routeScope,
  }), z.strictObject({
    provider: z.literal('openai-subscription'), endpoint: z.literal(CODEX_SUBSCRIPTION_ENDPOINT),
    model: subscriptionModelId, servingProviders: z.tuple([z.literal('openai')]), ...routeScope,
  }), z.strictObject({
    provider: z.literal('anthropic-subscription'), endpoint: z.literal(CLAUDE_SUBSCRIPTION_ENDPOINT),
    model: subscriptionModelId, servingProviders: z.tuple([z.literal('anthropic')]), ...routeScope,
  })])).max(100),
}).superRefine((policy, context) => {
  if (new Set(policy.routes.map(route => `${route.provider}:${route.model}`)).size !== policy.routes.length)
    context.addIssue({ code: 'custom', path: ['routes'], message: 'One serving route per transport and model' })
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
export function subscriptionModelRoute(route: string) {
  if (route === 'codex_cli' || route === 'codex_cpa') return { provider: 'openai-subscription' as const, endpoint: CODEX_SUBSCRIPTION_ENDPOINT }
  if (route === 'claude_code_cli' || route === 'claude_cpa') return { provider: 'anthropic-subscription' as const, endpoint: CLAUDE_SUBSCRIPTION_ENDPOINT }
  throw new ModelAdmissionError('modelRouteDenied')
}
export function admitModelRoute(policy: ModelAdmissionPolicy, request: {
  ownerId: string | null; provider: string; model: string; endpoint: string
}) {
  if (policy.revoked) throw new ModelAdmissionError('modelPolicyRevoked')
  if (!request.ownerId) throw new ModelAdmissionError('modelPrincipalUnavailable')
  const route = policy.routes.find(route => route.provider === request.provider && route.model === request.model && route.endpoint === request.endpoint &&
    (!route.principalIds || route.principalIds.includes(request.ownerId!)))
  if (!route) throw new ModelAdmissionError('modelRouteDenied')
  if (!route.dataRegions.includes('unknown')) throw new ModelAdmissionError('modelRegionUnverified')
  return { provider: route.provider, model: route.model, endpoint: route.endpoint,
    servingProviders: [...route.servingProviders], dataRegion: 'unknown' as const }
}
export function admitGatewayRoute(policy: ModelAdmissionPolicy, request: {
  ownerId: string | null
  model: string
  endpoint: string
}): GatewayAdmission {
  const admitted = admitModelRoute(policy, { ...request, provider: 'vercel-gateway' })
  return { model: request.model, endpoint: GATEWAY_MODEL_ENDPOINT,
    servingProviders: admitted.servingProviders, dataRegion: 'unknown' }
}

/** Caller-supplied fallback/BYOK/order options cannot broaden a managed route. */
export function managedGatewayOptions(admission: GatewayAdmission) {
  return { only: admission.servingProviders, order: admission.servingProviders, models: [] }
}
