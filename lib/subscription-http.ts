import { z } from 'zod'
import { SubscriptionRefusal, subscriptionRouteSchema } from '@mikka/protocol/subscription'
import type { SubscriptionService } from './subscription-service'
import { unavailableUsage, usageCache } from './subscription-usage'

const id = z.uuid()
const input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('connect'), workspaceId: id, provider: z.enum(['codex', 'claude']) }).strict(),
  z.object({ action: z.literal('reconnect'), connectionId: id, revision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('poll'), connectionId: id, state: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
  z.object({ action: z.literal('callback'), connectionId: id, state: z.string().regex(/^[A-Za-z0-9_-]{43}$/), callbackUrl: z.string().min(1).max(8192) }).strict(),
  z.object({ action: z.enum(['status', 'disconnect', 'recover']), connectionId: id, revision: z.number().int().positive().optional() }).strict(),
  z.object({ action: z.literal('bind'), connectionId: id, revision: z.number().int().positive(), consumerId: z.string().min(1).max(128), route: subscriptionRouteSchema.exclude(['openai_siwc']), modelId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/) }).strict()
])
const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' }
export interface SubscriptionHTTPDependencies {
  session(request: Request): Promise<{ userId: string; sessionId: string } | null>
  workspace(userId: string, workspaceId: string): Promise<void>
  service(custodyOnly?: boolean): SubscriptionService
}
export function subscriptionHTTP(deps: SubscriptionHTTPDependencies) {
  return async (request: Request): Promise<Response> => {
    try {
      if (request.method !== 'POST' || request.headers.get('sec-fetch-site') === 'cross-site' || (request.headers.has('origin') && request.headers.get('origin') !== new URL(request.url).origin)) return Response.json({ error: 'request_refused' }, { status: 403, headers })
      const session = await deps.session(request)
      if (!session) return Response.json({ error: 'auth_required' }, { status: 401, headers })
      if (!request.headers.get('content-type')?.startsWith('application/json')) return Response.json({ error: 'invalid_request' }, { status: 415, headers })
      const reader = request.body?.getReader()
      if (!reader) throw new Error('invalid_request')
      const chunks: Uint8Array[] = []; let size = 0
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 12000) { await reader.cancel(); throw new Error('invalid_request') }; chunks.push(value) } } finally { reader.releaseLock() }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      const parsed = input.safeParse(JSON.parse(new TextDecoder().decode(bytes)))
      if (!parsed.success) throw new Error('invalid_request')
      const body = parsed.data
      const service = deps.service(['status', 'disconnect', 'recover'].includes(body.action))
      if (body.action === 'connect') {
        await deps.workspace(session.userId, body.workspaceId)
        if (!service.capabilities.oauth?.[body.provider]) throw new SubscriptionRefusal('backend_unavailable')
        const connectionId = await service.repository.create(session.userId, body.workspaceId, body.provider)
        const row = await service.repository.connection(session.userId, connectionId)
        const result = await service.worker(service.repository.scope(row)).call<{ authorizationUrl: string; revision: number }>('oauthStart', { revision: Number(row.epoch), sessionId: session.sessionId }, request.signal)
        return Response.json({ connectionId, ...result }, { headers })
      }
      const row = await service.repository.connection(session.userId, body.connectionId)
      await deps.workspace(session.userId, row.workspaceId)
      const worker = service.worker(service.repository.scope(row))
      if (body.action === 'reconnect' && !service.capabilities.oauth?.[row.provider]) throw new SubscriptionRefusal('backend_unavailable')
      let result: unknown
      if (body.action === 'bind') result = { bindingId: await service.repository.bind(session.userId, row.workspaceId, body.consumerId, row.id, body.revision, body.route, body.modelId) }
      else if (body.action === 'status') result = await service.status(session.userId, row.id, request.signal)
      else if (body.action === 'poll') result = await worker.call('oauthPoll', { sessionId: session.sessionId, state: body.state }, request.signal)
      else if (body.action === 'callback') { await worker.call('oauthHandoff', { sessionId: session.sessionId, state: body.state, callbackUrl: body.callbackUrl }, request.signal); result = await service.status(session.userId, row.id, request.signal) }
      else if (body.action === 'reconnect') result = await worker.call('oauthStart', { revision: body.revision, sessionId: session.sessionId }, request.signal)
      else { await worker.call(body.action, { revision: body.revision }, request.signal); result = await service.status(session.userId, row.id, request.signal) }
      return Response.json(result, { headers })
    } catch (error) {
      const code = error instanceof SubscriptionRefusal ? error.code : 'subscription_unavailable'
      return Response.json({ error: code }, { status: 409, headers })
    }
  }
}

export async function subscriptionList(request: Request, deps: SubscriptionHTTPDependencies) {
  const session = await deps.session(request)
  if (!session) return Response.json({ error: 'auth_required' }, { status: 401, headers })
  try {
    const service = deps.service(true)
    const workspaceId = z.uuid().parse(new URL(request.url).searchParams.get('workspace'))
    await deps.workspace(session.userId, workspaceId)
    const { rows } = await service.repository.pool.query('select id,provider,state,epoch from byos_connections where "ownerId"=$1 and "workspaceId"=$2 order by "createdAt" desc limit 50', [session.userId, workspaceId])
    return Response.json({ enabled: true, providers: ['codex', 'claude'].map(provider => ({ provider, available: Boolean(service.capabilities.oauth?.[provider as 'codex' | 'claude']) })), connections: rows.map(row => ({ id: row.id, provider: row.provider, state: row.state, revision: Number(row.epoch) })) }, { headers })
  } catch (error) {
    if (error instanceof SubscriptionRefusal && error.code === 'backend_unavailable') return Response.json({ enabled: false, providers: [], connections: [] }, { headers })
    return Response.json({ error: 'subscription_unavailable' }, { status: 409, headers })
  }
}

const cachedUsage = usageCache()
/** Remaining 5-hour and weekly allowance of the owner's connected subscriptions.
 * Each read is cached a minute and fails soft to `unavailable`; tokens stay in
 * the worker. */
export async function subscriptionUsage(request: Request, deps: SubscriptionHTTPDependencies) {
  const session = await deps.session(request)
  if (!session) return Response.json({ error: 'auth_required' }, { status: 401, headers })
  try {
    const service = deps.service(true)
    const workspaceId = z.uuid().parse(new URL(request.url).searchParams.get('workspace'))
    await deps.workspace(session.userId, workspaceId)
    const { rows } = await service.repository.pool.query('select id,epoch from byos_connections where "ownerId"=$1 and "workspaceId"=$2 and state=\'connected\' order by "createdAt" desc limit 20', [session.userId, workspaceId])
    const connections = await Promise.all(rows.map(row => cachedUsage(`${session.userId}:${row.id}:${row.epoch}`, () =>
      service.usage(session.userId, row.id, AbortSignal.timeout(15_000)).catch(() => unavailableUsage(row.id)))))
    return Response.json({ connections }, { headers })
  } catch (error) {
    if (error instanceof SubscriptionRefusal && error.code === 'backend_unavailable') return Response.json({ connections: [] }, { headers })
    return Response.json({ error: 'subscription_unavailable' }, { status: 409, headers })
  }
}

/** Native CPA clients have no registered Mikka HTTPS callback. Complete inside
 * the authenticated application through device polling or explicit URL handoff. */
export async function subscriptionCallback(_request: Request, _deps: SubscriptionHTTPDependencies) {
  return Response.json({ error: 'callback_handoff_required' }, { status: 410, headers })
}
