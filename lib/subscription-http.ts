import { createHash } from 'node:crypto'
import { z } from 'zod'
import { SubscriptionRefusal, subscriptionRouteSchema } from '@mikka/protocol/subscription'
import type { SubscriptionService } from './subscription-service'
import { withBasePath } from './base-path'

const id = z.uuid()
const input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('connect'), workspaceId: id, provider: z.enum(['codex', 'claude']) }).strict(),
  z.object({ action: z.literal('reconnect'), connectionId: id, revision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('callback'), connectionId: id, state: z.string().length(43), code: z.string().min(1).max(4096) }).strict(),
  z.object({ action: z.enum(['status', 'disconnect', 'recover']), connectionId: id, revision: z.number().int().positive().optional() }).strict(),
  z.object({ action: z.literal('bind'), connectionId: id, revision: z.number().int().positive(), consumerId: z.string().min(1).max(128), route: subscriptionRouteSchema.exclude(['openai_siwc']), modelId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/) }).strict()
])
const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' }
export interface SubscriptionHTTPDependencies {
  session(request: Request): Promise<{ userId: string; sessionId: string } | null>
  workspace(userId: string, workspaceId: string): Promise<void>
  service(): SubscriptionService
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
      const service = deps.service()
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
      else if (body.action === 'callback') { await worker.call('oauthComplete', { sessionId: session.sessionId, state: body.state, code: body.code }, request.signal); result = await service.status(session.userId, row.id, request.signal) }
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
    const service = deps.service()
    const workspaceId = z.uuid().parse(new URL(request.url).searchParams.get('workspace'))
    await deps.workspace(session.userId, workspaceId)
    const { rows } = await service.repository.pool.query('select id,provider,state,epoch from byos_connections where "ownerId"=$1 and "workspaceId"=$2 order by "createdAt" desc limit 50', [session.userId, workspaceId])
    return Response.json({ enabled: true, providers: ['codex', 'claude'].map(provider => ({ provider, available: Boolean(service.capabilities.oauth?.[provider as 'codex' | 'claude']) })), connections: rows.map(row => ({ id: row.id, provider: row.provider, state: row.state, revision: Number(row.epoch) })) }, { headers })
  } catch (error) {
    if (error instanceof SubscriptionRefusal && error.code === 'backend_unavailable') return Response.json({ enabled: false, providers: [], connections: [] }, { headers })
    return Response.json({ error: 'subscription_unavailable' }, { status: 409, headers })
  }
}

/** Provider callback: find only this session owner's attempt, never a redirect target. */
export async function subscriptionCallback(request: Request, deps: SubscriptionHTTPDependencies) {
  const session = await deps.session(request)
  if (!session) return Response.json({ error: 'auth_required' }, { status: 401, headers })
  const url = new URL(request.url); const state = url.searchParams.get('state'); const code = url.searchParams.get('code')
  if (!state || state.length !== 43 || !code || code.length > 4096 || url.searchParams.has('error')) return Response.json({ error: 'callback_refused' }, { status: 409, headers })
  try {
    const service = deps.service()
    const { rows } = await service.repository.pool.query('select "connectionId" from byos_oauth_attempts where "stateHash"=$1 and "ownerId"=$2', [createHash('sha256').update(state).digest('hex'), session.userId])
    if (!rows[0]) throw new Error('callback_refused')
    const result = await subscriptionHTTP(deps)(new Request(new URL('/api/subscriptions', request.url), { method: 'POST', headers: { 'content-type': 'application/json', cookie: request.headers.get('cookie') ?? '' }, body: JSON.stringify({ action: 'callback', connectionId: rows[0].connectionId, state, code }), signal: request.signal }))
    return new Response(null, { status: 303, headers: { ...headers, Location: withBasePath(`/settings?section=integrations&subscription=${result.ok ? 'connected' : 'error'}`) } })
  } catch { return Response.json({ error: 'callback_refused' }, { status: 409, headers }) }
}
