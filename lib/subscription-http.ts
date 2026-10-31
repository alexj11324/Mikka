import { z } from 'zod'
import { SubscriptionRefusal, subscriptionRouteSchema } from '@mikka/protocol/subscription'
import type { SubscriptionService } from './subscription-service'
import { WorkerRefusal } from '../packages/daemon/src/subscription-worker-client'
import { noteLogUser } from './request-log'
import { accountLabel, failedUsage, usageCache } from './subscription-usage'

const id = z.uuid()
const input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('connect'), workspaceId: id, provider: z.enum(['codex', 'claude']) }).strict(),
  z.object({ action: z.literal('reconnect'), connectionId: id, revision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('poll'), connectionId: id, state: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
  z.object({ action: z.literal('callback'), connectionId: id, state: z.string().regex(/^[A-Za-z0-9_-]{43}$/), callbackUrl: z.string().min(1).max(8192) }).strict(),
  z.object({ action: z.enum(['status', 'disconnect', 'recover']), connectionId: id, revision: z.number().int().positive().optional() }).strict(),
  z.object({ action: z.literal('remove'), connectionId: id, revision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('bind'), connectionId: id, revision: z.number().int().positive(), consumerId: z.string().min(1).max(128), route: subscriptionRouteSchema.exclude(['openai_siwc']), modelId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/) }).strict()
])
const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' }
export interface SubscriptionHTTPDependencies {
  session(request: Request): Promise<{ userId: string; sessionId: string; tokenWorkspaceId?: string } | null>
  workspace(userId: string, workspaceId: string): Promise<void>
  service(custodyOnly?: boolean): SubscriptionService
  /** Receives one JSON line per refused request: action, provider, code and error class only. */
  log?: (line: string) => void
}
/** The refusal code a client may see. Worker codes are a fixed snake_case set
 * (packages/subscription-worker/errors.go); anything else stays generic. */
export function refusalCode(error: unknown) {
  if (error instanceof SubscriptionRefusal) return error.code
  if (error instanceof WorkerRefusal && /^[a-z_]{1,64}$/.test(error.code)) return error.code
  return 'subscription_unavailable'
}
export function subscriptionHTTP(deps: SubscriptionHTTPDependencies) {
  return async (request: Request): Promise<Response> => {
    const refused: { action?: string; provider?: string } = {}
    try {
      if (request.method !== 'POST' || request.headers.get('sec-fetch-site') === 'cross-site' || (request.headers.has('origin') && request.headers.get('origin') !== new URL(request.url).origin)) return Response.json({ error: 'request_refused' }, { status: 403, headers })
      const session = await deps.session(request)
      if (!session) return Response.json({ error: 'auth_required' }, { status: 401, headers })
      noteLogUser(session.userId)
      if (!request.headers.get('content-type')?.startsWith('application/json')) return Response.json({ error: 'invalid_request' }, { status: 415, headers })
      const reader = request.body?.getReader()
      if (!reader) throw new Error('invalid_request')
      const chunks: Uint8Array[] = []; let size = 0
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 12000) { await reader.cancel(); throw new Error('invalid_request') }; chunks.push(value) } } finally { reader.releaseLock() }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      const parsed = input.safeParse(JSON.parse(new TextDecoder().decode(bytes)))
      if (!parsed.success) throw new Error('invalid_request')
      const body = parsed.data
      refused.action = body.action
      if (body.action === 'connect') refused.provider = body.provider
      const service = deps.service(['status', 'disconnect', 'recover', 'remove'].includes(body.action))
      if (body.action === 'connect') {
        if (session.tokenWorkspaceId && session.tokenWorkspaceId !== body.workspaceId) return Response.json({ error: 'workspaceAccessDenied' }, { status: 403, headers })
        await deps.workspace(session.userId, body.workspaceId)
        if (!service.capabilities.oauth?.[body.provider]) throw new SubscriptionRefusal('backend_unavailable')
        const connectionId = await service.repository.create(session.userId, body.workspaceId, body.provider)
        const row = await service.repository.connection(session.userId, connectionId)
        const result = await service.worker(service.repository.scope(row)).call<{ authorizationUrl: string; revision: number }>('oauthStart', { revision: Number(row.epoch), sessionId: session.sessionId }, request.signal)
        return Response.json({ connectionId, ...result }, { headers })
      }
      const row = await service.repository.connection(session.userId, body.connectionId)
      refused.provider = row.provider
      if (session.tokenWorkspaceId && session.tokenWorkspaceId !== row.workspaceId) return Response.json({ error: 'workspaceAccessDenied' }, { status: 403, headers })
      await deps.workspace(session.userId, row.workspaceId)
      const worker = service.worker(service.repository.scope(row))
      if (body.action === 'reconnect' && !service.capabilities.oauth?.[row.provider]) throw new SubscriptionRefusal('backend_unavailable')
      let result: unknown
      if (body.action === 'bind') result = { bindingId: await service.repository.bind(session.userId, row.workspaceId, body.consumerId, row.id, body.revision, body.route, body.modelId) }
      else if (body.action === 'status') result = await service.status(session.userId, row.id, request.signal)
      else if (body.action === 'poll') result = await worker.call('oauthPoll', { sessionId: session.sessionId, state: body.state }, request.signal)
      else if (body.action === 'callback') { await worker.call('oauthHandoff', { sessionId: session.sessionId, state: body.state, callbackUrl: body.callbackUrl }, request.signal); result = await service.status(session.userId, row.id, request.signal) }
      else if (body.action === 'reconnect') result = await worker.call('oauthStart', { revision: body.revision, sessionId: session.sessionId }, request.signal)
      else if (body.action === 'remove') {
        // 移除: fence and clean up like 断开连接 first, then hide the row for good.
        if (row.state !== 'disconnected') await worker.call('disconnect', { revision: body.revision }, request.signal)
        await service.repository.remove(session.userId, row.id)
        result = { id: row.id, removed: true }
      }
      else { await worker.call(body.action, { revision: body.revision }, request.signal); result = await service.status(session.userId, row.id, request.signal) }
      return Response.json(result, { headers })
    } catch (error) {
      const code = refusalCode(error)
      // Never the message, URL, state or body: those can carry provider or secret data.
      try { (deps.log ?? console.warn)(JSON.stringify({ level: 'warn', msg: 'subscription_refused', action: refused.action ?? null, provider: refused.provider ?? null, code, error: error instanceof Error ? error.name : 'unknown' })) } catch { /* logging never breaks a request */ }
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
    if (session.tokenWorkspaceId && session.tokenWorkspaceId !== workspaceId) return Response.json({ error: 'workspaceAccessDenied' }, { status: 403, headers })
    await deps.workspace(session.userId, workspaceId)
    const { rows } = await service.repository.pool.query('select id,provider,state,epoch,"accountLabel" from byos_connections where "ownerId"=$1 and "workspaceId"=$2 and "removedAt" is null order by "createdAt" desc limit 50', [session.userId, workspaceId])
    // Which Bots use each connection is a nicety: the list still loads without it.
    const bots = await service.repository.connectionBots(session.userId, workspaceId).catch(() => [])
    return Response.json({ enabled: true, providers: ['codex', 'claude'].map(provider => ({ provider, available: Boolean(service.capabilities.oauth?.[provider as 'codex' | 'claude']) })), connections: rows.map(row => ({ id: row.id, provider: row.provider, state: row.state, revision: Number(row.epoch), account: accountLabel(row.accountLabel), bots: bots.filter(bot => bot.connectionId === row.id).map(({ id, name, color, shape }) => ({ id, name, color, shape })) })) }, { headers })
  } catch (error) {
    if (error instanceof SubscriptionRefusal && error.code === 'backend_unavailable') return Response.json({ enabled: false, providers: [], connections: [] }, { headers })
    return Response.json({ error: 'subscription_unavailable' }, { status: 409, headers })
  }
}

const cachedUsage = usageCache()
/** Remaining 5-hour and weekly allowance of the owner's connected subscriptions.
 * Reads are kept per status (USAGE_TTL_MS: a refused sign-in 10 minutes, a
 * temporary failure not at all); `?refresh=1` (重试) skips a kept read at most
 * once a minute. Tokens stay in the worker; a read never changes a connection. */
export async function subscriptionUsage(request: Request, deps: SubscriptionHTTPDependencies) {
  const session = await deps.session(request)
  if (!session) return Response.json({ error: 'auth_required' }, { status: 401, headers })
  try {
    const service = deps.service(true)
    const workspaceId = z.uuid().parse(new URL(request.url).searchParams.get('workspace'))
    if (session.tokenWorkspaceId && session.tokenWorkspaceId !== workspaceId) return Response.json({ error: 'workspaceAccessDenied' }, { status: 403, headers })
    await deps.workspace(session.userId, workspaceId)
    const { rows } = await service.repository.pool.query('select id,epoch from byos_connections where "ownerId"=$1 and "workspaceId"=$2 and state=\'connected\' order by "createdAt" desc limit 20', [session.userId, workspaceId])
    const force = new URL(request.url).searchParams.get('refresh') === '1'
    const connections = await Promise.all(rows.map(row => cachedUsage(`${session.userId}:${row.id}:${row.epoch}`, () =>
      service.usage(session.userId, row.id, AbortSignal.timeout(15_000)).catch(() => failedUsage(row.id, 'unavailable')), force)))
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
