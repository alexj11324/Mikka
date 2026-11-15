import 'server-only'
import { randomUUID } from 'node:crypto'
import { pool } from '@/lib/db'
import { catalogModel } from '@/lib/model-catalog'
import { PaidResourceError } from '@/lib/abuse/policy'
import { requestGatewayToken, verifyGatewayToken, type GatewayGrant } from './token'
import { upstreamRequest, type GatewayOperation, type GatewayUpstream } from './upstream'
import { gatewayCostMicroUsd, readGatewayUsage, type GatewayProtocol } from './usage'
import { withoutDisabledFeatures } from './features'
import { gatewayLiteLlm } from './config'

/** The same input-size boundary the hosted model applies to one call. */
const MAX_BODY_BYTES = 16 * 1024 * 1024

type Fetch = typeof fetch
export interface GatewayDependencies {
  fetch: Fetch
  verify(token: string): Promise<GatewayGrant | null>
  /** The upstream for a grant; throws a `GatewayRefusal` when nothing may serve it. */
  upstream(grant: GatewayGrant, protocol: GatewayProtocol): Promise<{ upstream: GatewayUpstream; features?: import('./features').GatewayFeatures }>
  /** Mikka 额度 only: holds a call's worth of credit; resolves to the hold's id. Throws `PaidResourceError` when nothing can pay. */
  reserve(grant: GatewayGrant, id: string): Promise<void>
  settle(id: string, cost: number | null, usage: ReturnType<typeof readGatewayUsage>): Promise<void>
  /** The catalogue the cost is priced from. */
  catalogue(): Promise<readonly import('@/lib/model-catalog').CatalogModel[]>
}

/** A refusal the CLI reads as its provider's own error. */
export class GatewayRefusal extends Error {
  constructor(readonly status: number, readonly code: string, options?: ErrorOptions) { super(code, options); this.name = 'GatewayRefusal' }
}

function errorResponse(protocol: GatewayProtocol, status: number, code: string): Response {
  const body = protocol === 'anthropic'
    ? { type: 'error', error: { type: status === 401 ? 'authentication_error' : status === 402 ? 'billing_error' : status === 400 ? 'invalid_request_error' : 'api_error', message: code } }
    : { error: { message: code, type: status === 402 ? 'insufficient_quota' : status === 401 ? 'invalid_api_key' : 'invalid_request_error', code } }
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

/**
 * Collects the lines that report usage as the response streams through, so the
 * whole body is never held in memory.
 */
function usageTap(onDone: (text: string) => Promise<void>) {
  const decoder = new TextDecoder()
  let partial = '', kept = '', closed = false
  const keep = (line: string) => { if (line.includes('usage')) kept += line + '\n' }
  const finish = async () => {
    if (closed) return
    closed = true
    keep(partial)
    await onDone(kept)
  }
  return {
    finish,
    stream: new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk)
        const lines = (partial + decoder.decode(chunk, { stream: true })).split('\n')
        partial = lines.pop() ?? ''
        for (const line of lines) keep(line)
      },
      async flush() { await finish() },
    }),
  }
}

/**
 * One request from a run's CLI (decision 2026-11-15-2000): authenticate the
 * run's token, pin the run's frozen model, hold credit when Mikka pays, forward
 * as a stream, then settle at the list price of what the provider reported.
 */
export async function handleModelGateway(request: Request, protocol: GatewayProtocol, operation: GatewayOperation, dependencies: GatewayDependencies = defaultDependencies()): Promise<Response> {
  const token = requestGatewayToken(request.headers)
  const grant = token ? await dependencies.verify(token) : null
  if (!grant) return errorResponse(protocol, 401, 'model_gateway_token_invalid')
  if ((grant.harness === 'claude_code') !== (protocol === 'anthropic')) return errorResponse(protocol, 403, 'model_gateway_protocol_mismatch')
  const length = Number(request.headers.get('content-length') ?? 0)
  if (length > MAX_BODY_BYTES) return errorResponse(protocol, 413, 'model_gateway_body_too_large')
  let body: Record<string, unknown>
  try {
    const text = await request.text()
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) return errorResponse(protocol, 413, 'model_gateway_body_too_large')
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return errorResponse(protocol, 400, 'model_gateway_body_invalid')
    body = parsed as Record<string, unknown>
  } catch { return errorResponse(protocol, 400, 'model_gateway_body_invalid') }

  let resolved: Awaited<ReturnType<GatewayDependencies['upstream']>>
  try { resolved = await dependencies.upstream(grant, protocol) }
  catch (error) {
    if (error instanceof GatewayRefusal) return errorResponse(protocol, error.status, error.code)
    throw new Error('model_gateway_upstream_unavailable', { cause: error })
  }
  const metered = grant.source.kind === 'credits' && operation !== 'count_tokens'
  const holdId = randomUUID()
  if (metered) {
    try { await dependencies.reserve(grant, holdId) }
    catch (error) {
      if (error instanceof PaidResourceError) return errorResponse(protocol, 402, error.code)
      throw new Error('model_gateway_reserve_failed', { cause: error })
    }
  }
  const outgoing = upstreamRequest({ protocol, operation, model: grant.model, body: withoutDisabledFeatures(body, resolved.features ?? {}), clientHeaders: request.headers, upstream: resolved.upstream })
  let response: Response
  try {
    response = await dependencies.fetch(outgoing.url, { method: 'POST', headers: outgoing.headers, body: JSON.stringify(outgoing.body), redirect: 'error', signal: request.signal })
  } catch (error) {
    if (metered) await dependencies.settle(holdId, 0, null)
    if (request.signal.aborted) return errorResponse(protocol, 499, 'model_gateway_client_closed')
    console.warn(JSON.stringify({ msg: 'model_gateway_upstream_failed', runId: grant.runId, source: grant.source.kind, error: error instanceof Error ? error.name : 'unknown' }))
    return errorResponse(protocol, 502, 'model_gateway_upstream_failed')
  }
  const headers = new Headers({ 'cache-control': 'no-store' })
  const type = response.headers.get('content-type')
  if (type) headers.set('content-type', type)
  if (!metered || !response.body) {
    if (metered) await dependencies.settle(holdId, response.ok ? null : 0, null)
    return new Response(response.body, { status: response.status, headers })
  }
  if (!response.ok) {
    // A refused request (bad parameters, provider limits) cost nothing.
    await dependencies.settle(holdId, 0, null)
    return new Response(response.body, { status: response.status, headers })
  }
  const tap = usageTap(async text => {
    const usage = readGatewayUsage(protocol, text)
    const model = catalogModel(grant.model, await dependencies.catalogue())
    await dependencies.settle(holdId, usage ? gatewayCostMicroUsd(model, usage) : null, usage)
  })
  // A client that stops reading still owes what the provider already produced.
  request.signal.addEventListener('abort', () => { void tap.finish() }, { once: true })
  return new Response(response.body.pipeThrough(tap.stream), { status: response.status, headers })
}

function defaultDependencies(): GatewayDependencies {
  return {
    fetch,
    verify: token => verifyGatewayToken(pool, token),
    upstream: (grant, protocol) => resolveGatewayUpstream(grant, protocol),
    async reserve(grant, id) {
      if (!grant.workspaceId) throw new PaidResourceError('free_allowance_used')
      const [{ hostedUsage }, { withSharedCredits }, { hostedBillingScope }] = await Promise.all([
        import('@/lib/abuse/runtime'), import('@/lib/credit-shares'), import('@/lib/abuse/context')])
      const workspaceId = grant.workspaceId
      await hostedBillingScope.run({ workspaceId, ownerId: grant.ownerId, runId: grant.runId, actorId: grant.ownerId },
        () => withSharedCredits(workspaceId, payer => hostedUsage.reserve(payer, grant.model, id, process.env)))
    },
    async settle(id, cost, usage) {
      const { hostedUsage } = await import('@/lib/abuse/runtime')
      await hostedUsage.settle(id, cost, usage?.inputTokens ?? 0, usage?.outputTokens ?? 0, undefined,
        usage ? { read: usage.cacheReadTokens, write: usage.cacheWriteTokens } : null)
    },
    catalogue: async () => (await import('@/lib/model-catalog-server')).modelCatalog(),
  }
}

/** The run's frozen source, opened for this one request. */
export async function resolveGatewayUpstream(grant: GatewayGrant, protocol: GatewayProtocol, env: Record<string, string | undefined> = process.env): Promise<{ upstream: GatewayUpstream; features?: import('./features').GatewayFeatures }> {
  if (grant.source.kind === 'credits') {
    const models = await (await import('@/lib/model-catalog-server')).modelCatalog()
    if (!catalogModel(grant.model, models)?.pricing) throw new GatewayRefusal(400, 'model_gateway_model_unpriced')
    const auth = await (await import('@/lib/ai-gateway-auth')).gatewayAuth(env)
    if (!auth) throw new GatewayRefusal(503, 'model_gateway_unconfigured')
    return { upstream: { kind: 'vercel', token: auth.token } }
  }
  const { openGatewayApiKey } = await import('@/lib/model-api-keys')
  const opened = await openGatewayApiKey(pool, grant.source.keyId, env).catch((error: unknown) => {
    throw new GatewayRefusal(401, 'model_gateway_key_unavailable', { cause: error })
  })
  const { apiKeyEndpoint, apiKeyChatBaseUrl } = await import('@/lib/model-api-key-providers')
  const native = apiKeyEndpoint(opened.key, protocol === 'anthropic' ? 'claude_code' : 'codex')
  if (native) return { upstream: { kind: 'provider', baseUrl: native.baseUrl, key: opened.apiKey }, features: opened.features }
  const chatBaseUrl = apiKeyChatBaseUrl(opened.key)
  const litellm = gatewayLiteLlm(env)
  if (!chatBaseUrl || !litellm) throw new GatewayRefusal(400, 'model_gateway_protocol_unsupported')
  return { upstream: { kind: 'litellm', url: litellm.url, masterKey: litellm.masterKey, chatBaseUrl, key: opened.apiKey }, features: opened.features }
}
