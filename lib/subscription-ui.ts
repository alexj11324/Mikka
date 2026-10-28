import { z } from 'zod'

export const subscriptionListSchema = z.object({
  enabled: z.boolean(),
  providers: z.array(z.object({ provider: z.enum(['codex', 'claude']), available: z.boolean() })),
  connections: z.array(z.object({ id: z.uuid(), provider: z.enum(['codex', 'claude']), state: z.string(), revision: z.number().int().positive() })),
})
const startSchema = z.object({
  connectionId: z.uuid(), flow: z.enum(['device', 'callback_handoff']), state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  authorizationUrl: z.url(), revision: z.number().int().positive(), expiresAt: z.string(),
  userCode: z.string().min(1).max(64).regex(/^[^\r\n\0]+$/).optional(), interval: z.number().int().min(5).max(900).optional(),
})

/** Accept provider-owned authorization URLs only; never navigate to a URL
 * supplied by a model, arbitrary redirect or unexpected OAuth response. */
export function parseSubscriptionStart(value: unknown, provider: 'codex' | 'claude') {
  const result = startSchema.parse(value)
  const url = new URL(result.authorizationUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !Number.isFinite(Date.parse(result.expiresAt))) throw new Error('Invalid authorization')
  if (provider === 'codex') {
    if (result.flow !== 'device' || url.origin !== 'https://auth.openai.com' || url.pathname !== '/codex/device' || url.search || !result.userCode || !result.interval) throw new Error('Invalid authorization')
  } else if (result.flow !== 'callback_handoff' || url.origin !== 'https://claude.ai' || url.pathname !== '/oauth/authorize' || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== result.state || url.searchParams.getAll('redirect_uri').length !== 1 || url.searchParams.get('redirect_uri') !== 'http://localhost:54545/callback' || url.searchParams.get('code_challenge_method') !== 'S256') throw new Error('Invalid authorization')
  return result
}

/** GET /api/subscriptions/usage: what is left of each connected plan's windows. */
export const subscriptionUsageSchema = z.object({
  connections: z.array(z.object({
    id: z.uuid(),
    status: z.enum(['ok', 'unavailable']),
    account: z.string().max(256).nullable(),
    plan: z.string().max(40).nullable(),
    windows: z.array(z.object({ kind: z.enum(['five_hour', 'weekly']), remaining: z.number().min(0).max(100), resetsAt: z.string().nullable() })).max(2),
  })).max(50),
})
export type SubscriptionUsageView = z.infer<typeof subscriptionUsageSchema>['connections'][number]
