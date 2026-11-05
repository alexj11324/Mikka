import { z } from 'zod'
import { SubscriptionRefusal, subscriptionRouteSchema } from '@mikka/protocol/subscription'
import type { SubscriptionService } from './subscription-service'
import { WorkerRefusal } from '../packages/daemon/src/subscription-worker-client'
import { noteLogUser } from './request-log'
import { accountLabel, failedUsage, usageCache } from './subscription-usage'
import { stopRunsUsingSubscriptions } from './personal-policy'
import { ownerSettingsChanged } from './live/lists'
import { expireSubscriptionAcquisitions } from './subscription-acquire-expiry'

const id = z.uuid()
const input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('connect'), workspaceId: id, provider: z.enum(['codex', 'claude']) }).strict(),
  z.object({ action: z.literal('reconnect'), connectionId: id, revision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('resume'), connectionId: id }).strict(),
  z.object({ action: z.literal('poll'), connectionId: id, state: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
  z.object({ action: z.literal('callback'), connectionId: id, state: z.string().regex(/^[A-Za-z0-9_-]{43}$/), callbackUrl: z.string().min(1).max(8192) }).strict(),
  z.object({ action: z.enum(['status', 'disconnect', 'recover']), connectionId: id, revision: z.number().int().positive().optional() }).strict(),
  z.object({ action: z.literal('remove'), connectionId: id, revision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('pause'), connectionId: id, paused: z.boolean() }).strict(),
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
/** A sign-in that never started leaves no row: each failed 连接 would otherwise add one. Best effort, so the refusal itself still reaches the page. */
async function discardUnstarted(service: SubscriptionService, userId: string, connectionId: string, worker: { call(method: string, params: unknown): Promise<unknown> }) {
  try {
    const row = await service.repository.connection(userId, connectionId)
    // A lost response can still leave a valid start in flight. Its bounded
    // operation is resumable and the expiry sweep handles an abandoned start.
    if (row.state === 'pending' || row.state === 'publication_pending' || row.state === 'connected') return
    await worker.call('disconnect', { revision: Number(row.epoch) })
    await service.repository.remove(userId, connectionId)
  } catch { /* still listed; 移除 clears it */ }
}
export function subscriptionHTTP(deps: SubscriptionHTTPDependencies) {
  return async (request: Request): Promise<Response> => {
    const refused: { action?: string; provider?: string } = {}
    // The connection this request touched and what it looked like before, so any state change the worker made
    // (including on a refusal partway through, or a refresh that ended in reconnect_required) reaches open pages.
    let watched: { pool: SubscriptionService['repository']['pool']; repository: SubscriptionService['repository']; userId: string; id: string; seen: string } | null = null
    const moved = async () => {
      if (!watched) return false
      const now = await watched.repository.connection(watched.userId, watched.id).then(row => `${row.state}:${row.paused}`, () => 'gone')
      return now !== watched.seen
    }
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
      const service = deps.service(['status', 'resume', 'disconnect', 'recover', 'remove', 'pause'].includes(body.action))
      // A provider grant can be consumed once. Leaving the page must not kill
      // that worker halfway through a durable claim. The server owns this
      // bounded lifetime; explicit Cancel still fences publication in SQL.
      const acquisitionSignal = () => AbortSignal.timeout(35_000)
      if (body.action === 'connect') {
        if (session.tokenWorkspaceId && session.tokenWorkspaceId !== body.workspaceId) return Response.json({ error: 'workspaceAccessDenied' }, { status: 403, headers })
        await deps.workspace(session.userId, body.workspaceId)
        if (!service.capabilities.oauth?.[body.provider]) throw new SubscriptionRefusal('backend_unavailable')
        const expired = await expireSubscriptionAcquisitions(service.repository.pool, session.userId)
        const { connectionId, created } = await service.repository.acquire(session.userId, body.workspaceId, body.provider)
        const row = await service.repository.connection(session.userId, connectionId)
        watched = { pool: service.repository.pool, repository: service.repository, userId: session.userId, id: row.id, seen: `${row.state}:${row.paused}` }
        const worker = service.worker(service.repository.scope(row))
        const result = await worker.call<{ authorizationUrl: string; revision: number }>('oauthStart', { revision: Number(row.epoch), sessionId: session.sessionId }, acquisitionSignal())
          .catch(async (failure: unknown) => { if (created) await discardUnstarted(service, session.userId, connectionId, worker); throw failure })
        if (created || expired.expired) await ownerSettingsChanged(service.repository.pool, session.userId)
        return Response.json({ connectionId, ...result }, { headers })
      }
      const row = await service.repository.connection(session.userId, body.connectionId)
      watched = { pool: service.repository.pool, repository: service.repository, userId: session.userId, id: row.id, seen: `${row.state}:${row.paused}` }
      refused.provider = row.provider
      if (session.tokenWorkspaceId && session.tokenWorkspaceId !== row.workspaceId) return Response.json({ error: 'workspaceAccessDenied' }, { status: 403, headers })
      await deps.workspace(session.userId, row.workspaceId)
      const worker = service.worker(service.repository.scope(row))
      if (body.action === 'reconnect' && !service.capabilities.oauth?.[row.provider]) throw new SubscriptionRefusal('backend_unavailable')
      let result: unknown
      if (body.action === 'bind') result = { bindingId: await service.repository.bind(session.userId, row.workspaceId, body.consumerId, row.id, body.revision, body.route, body.modelId) }
      else if (body.action === 'status') result = await service.status(session.userId, row.id, request.signal)
      else if (body.action === 'resume') result = { connectionId: row.id, ...await worker.call<Record<string, unknown>>('oauthResume', { sessionId: session.sessionId }, request.signal) }
      else if (body.action === 'poll') result = await worker.call('oauthPoll', { sessionId: session.sessionId, state: body.state }, acquisitionSignal())
      else if (body.action === 'callback') {
        const signal = acquisitionSignal()
        await worker.call('oauthHandoff', { sessionId: session.sessionId, state: body.state, callbackUrl: body.callbackUrl }, signal)
        result = await service.status(session.userId, row.id, signal)
      }
      else if (body.action === 'reconnect') {
        const signal = acquisitionSignal()
        // Explicit restart also works for an old browser session or legacy
        // attempt without recovery data. Only this action replaces a start.
        const revision = row.state === 'pending'
          ? (await worker.call<{ revision: number }>('disconnect', { revision: body.revision }, signal)).revision
          : body.revision
        result = { connectionId: row.id, ...await worker.call<Record<string, unknown>>('oauthStart', { revision, sessionId: session.sessionId }, signal) }
      }
      else if (body.action === 'pause') {
        await service.repository.setPaused(session.userId, row.id, body.paused)
        result = { id: row.id, paused: body.paused }
      }
      else if (body.action === 'remove') {
        // 移除: fence and clean up like 断开连接 first, then hide the row for good.
        if (row.state !== 'disconnected') await worker.call('disconnect', { revision: body.revision }, request.signal)
        await service.repository.remove(session.userId, row.id)
        result = { id: row.id, removed: true }
      }
      else {
        const signal = body.action === 'disconnect' ? acquisitionSignal() : request.signal
        await worker.call(body.action, { revision: body.revision }, signal)
        result = await service.status(session.userId, row.id, signal)
      }
      // 断开连接 / 移除: runs using this connection stop now, wherever they run.
      if (body.action === 'disconnect' || body.action === 'remove') await stopRunsUsingSubscriptions(service.repository.pool, { ownerId: session.userId, connectionId: row.id })
      // Connected, paused, removed or signed out: every open 模型与订阅 page re-reads (no polling, no content on the wire).
      // A device sign-in still waiting changed nothing yet.
      const pending = body.action === 'poll' && (result as { pending?: unknown } | null)?.pending === true
      if ((body.action !== 'bind' && body.action !== 'status' && body.action !== 'resume' && !pending) || await moved()) await ownerSettingsChanged(service.repository.pool, session.userId)
      return Response.json(result, { headers })
    } catch (error) {
      if (watched && await moved().catch(() => false)) await ownerSettingsChanged(watched.pool, watched.userId)
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
    const expired = await expireSubscriptionAcquisitions(service.repository.pool, session.userId)
    if (expired.expired) await ownerSettingsChanged(service.repository.pool, session.userId)
    // A subscription belongs to the account (decision 2026-10-31-2130): every workspace lists the same
    // connections. The same provider account connected in two workspaces shows once; nothing is deleted.
    const { rows: all } = await service.repository.pool.query('select id,"ownerId","workspaceId",provider,state,epoch,"accountLabel","providerSubject",paused,"lastErrorCode" from byos_connections where "ownerId"=$1 and "removedAt" is null and state<>\'disconnected\' order by "createdAt" desc limit 50', [session.userId])
    const subjects = new Set<string>()
    const rows = all.filter(row => !row.providerSubject || (subjects.has(`${row.provider}:${row.providerSubject}`) ? false : (subjects.add(`${row.provider}:${row.providerSubject}`), true)))
    // Current saved chat selections here, not historical bindings or active runs.
    // This optional projection never exposes another workspace or member's bots.
    const bots = await service.repository.connectionBots(session.userId, workspaceId).catch(() => [])
    // Listing needs custody only; sign-in needs the full runtime (connect). Offer
    // 连接 only when that runtime exists, or every click fails the same way.
    let signIn: SubscriptionService | null = null
    try { signIn = deps.service(false) } catch { /* custody-only deployment: list and remove still work */ }
    const connections = await Promise.all(rows.map(async row => {
      let activeAttempt: Record<string, unknown> | null = null
      if (row.state === 'pending' && (!session.tokenWorkspaceId || session.tokenWorkspaceId === row.workspaceId)) {
        try {
          if (row.workspaceId !== workspaceId) await deps.workspace(session.userId, row.workspaceId)
          const scope = { ownerId: session.userId, workspaceId: row.workspaceId, connectionId: row.id, provider: row.provider }
          const resumed = await service.worker(scope).call<Record<string, unknown>>('oauthResume', { sessionId: session.sessionId }, request.signal)
          // A concurrent start/reconnect can advance the row after this list
          // snapshot. Never mix its new ceremony into the previous revision.
          if (resumed.revision === Number(row.epoch)) activeAttempt = { ...resumed, connectionId: row.id }
        } catch { /* starting, another session, or expired: keep the row available for explicit restart */ }
      }
      return { id: row.id, provider: row.provider, state: row.state, revision: Number(row.epoch), account: accountLabel(row.accountLabel), paused: row.paused === true, lastErrorCode: row.lastErrorCode ?? null, activeAttempt, bots: bots.filter(bot => bot.connectionId === row.id && bot.workspaceId === workspaceId).map(({ id, name, color, shape, workspaceId }) => ({ id, name, color, shape, workspaceId })) }
    }))
    return Response.json({ enabled: true, providers: ['codex', 'claude'].map(provider => ({ provider, available: Boolean(signIn?.capabilities.oauth?.[provider as 'codex' | 'claude']) })), connections }, { headers })
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
    const { rows } = await service.repository.pool.query('select id,epoch from byos_connections where "ownerId"=$1 and state=\'connected\' order by "createdAt" desc limit 20', [session.userId])
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
