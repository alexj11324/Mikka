import 'server-only'
import { randomUUID } from 'node:crypto'
import { db, pool } from '@/lib/db'
import { catalogModel } from '@/lib/model-catalog'
import { PaidResourceError } from '@/lib/abuse/policy'
import { requestGatewayToken, verifyGatewayToken, type GatewayGrant } from './token'
import { upstreamRequest, type GatewayOperation, type GatewayUpstream } from './upstream'
import { gatewayCostMicroUsd, readGatewayReceipt, type GatewayProtocol, type GatewayUsage } from './usage'
import { withoutDisabledFeatures } from './features'
import { isCloudEdition } from '@/lib/edition'
import { gatewayLiteLlm, SELF_HOSTED_DEFAULT_CATALOG_ID } from './config'
import { readRunChain } from '@/lib/run-chain'
import { recordExternalModelUsage, type ModelReceipt } from './ledger'
import { liteLLMResponseCost } from './litellm-client'

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
  settle(id: string, cost: number | null, usage: GatewayUsage | null, generationId?: string, messageId?: string | null): Promise<void>
  recordExternal?(grant: GatewayGrant, id: string, receipt: ModelReceipt): Promise<void>
  /** The catalogue the cost is priced from. */
  catalogue(): Promise<readonly import('@/lib/model-catalog').CatalogModel[]>
  /** Nothing can pay: the run stops with the refusal as its reason, so the thread shows 「Mikka 额度已用完」. */
  refused?(grant: GatewayGrant, code: string): Promise<void>
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
function usageTap(streaming: boolean, onDone: (text: string) => Promise<void>) {
  const decoder = new TextDecoder()
  let partial = '', kept = '', closed = false
  const keep = (line: string) => {
    if (kept.length < MAX_BODY_BYTES && (!streaming || line.includes('usage') || line.includes('message_start') || line.includes('response.created'))) kept += line + '\n'
  }
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
      if (error instanceof PaidResourceError) {
        await dependencies.refused?.(grant, error.code).catch((cause: unknown) =>
          console.warn(JSON.stringify({ msg: 'model_gateway_refusal_unrecorded', runId: grant.runId, error: cause instanceof Error ? cause.name : 'unknown' })))
        return errorResponse(protocol, 402, error.code)
      }
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
  const generationId = response.headers.get('x-litellm-call-id') ?? undefined
  const headers = new Headers({ 'cache-control': 'no-store' })
  const type = response.headers.get('content-type')
  if (type) headers.set('content-type', type)
  const observable = operation !== 'count_tokens' && !!dependencies.recordExternal && !!grant.workspaceId
  if ((!metered && !observable) || !response.body) {
    if (metered) await dependencies.settle(holdId, response.ok ? null : 0, null, generationId)
    return new Response(response.body, { status: response.status, headers })
  }
  if (!response.ok) {
    // A refused request (bad parameters, provider limits) cost nothing.
    if (metered) await dependencies.settle(holdId, 0, null, generationId)
    return new Response(response.body, { status: response.status, headers })
  }
  const tap = usageTap(type?.includes('text/event-stream') ?? false, async text => {
    const receipt = readGatewayReceipt(protocol, text)
    const cost = receipt.cost ?? liteLLMResponseCost(response.headers)
    if (metered) {
      const settledCost = receipt.usage
        ? gatewayCostMicroUsd(catalogModel(grant.model, await dependencies.catalogue()), receipt.usage) : null
      await dependencies.settle(holdId, settledCost, receipt.usage, generationId, receipt.messageId)
    } else if (receipt.messageId || receipt.usage || cost !== null) {
      await dependencies.recordExternal?.(grant, holdId, { ...receipt, cost, generationId })
    }
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
      const threadId = (await readRunChain(pool, grant.ownerId, grant.runId))?.rootRunId
      await hostedBillingScope.run({ workspaceId, ownerId: grant.ownerId, runId: grant.runId, actorId: grant.ownerId, threadId, billingSource: 'credits' },
        () => withSharedCredits(workspaceId, payer => hostedUsage.reserve(payer, grant.model, id, process.env)))
    },
    async settle(id, cost, usage, generationId, messageId) {
      const { hostedUsage } = await import('@/lib/abuse/runtime')
      await hostedUsage.settle(id, cost, usage?.inputTokens ?? 0, usage?.outputTokens ?? 0, generationId,
        usage ? { read: usage.cacheReadTokens, write: usage.cacheWriteTokens } : null, messageId)
    },
    async recordExternal(grant, id, receipt) {
      if (!grant.workspaceId || grant.source.kind !== 'api_key') return
      const threadId = (await readRunChain(pool, grant.ownerId, grant.runId))?.rootRunId ?? null
      await recordExternalModelUsage(db, { ...receipt, id, threadId, workspaceId: grant.workspaceId, ownerId: grant.ownerId,
        runId: grant.runId, model: grant.model, source: 'api_key' })
    },
    catalogue: async () => (await import('@/lib/model-catalog-server')).modelCatalog(),
    async refused(grant, code) {
      const stopped = await pool.query(`UPDATE agent_runs SET "stopRequestedAt"=COALESCE("stopRequestedAt",now()),"stopReason"=COALESCE("stopReason",$2),
          error=COALESCE(error,$2),"updatedAt"=now() WHERE id=$1 AND status NOT IN ('succeeded','failed','stopped','cancelled') RETURNING id`, [grant.runId, code])
      if (stopped.rowCount) await (await import('@/lib/live/panels')).runChanged(pool, grant.runId)
    },
  }
}

/** The run's frozen source, opened for this one request. */
export async function resolveGatewayUpstream(grant: GatewayGrant, protocol: GatewayProtocol, env: Record<string, string | undefined> = process.env): Promise<{ upstream: GatewayUpstream; features?: import('./features').GatewayFeatures }> {
  const litellm = gatewayLiteLlm(env)
  if (!litellm) throw new GatewayRefusal(503, 'model_gateway_unconfigured')
  if (grant.source.kind === 'credits') {
    if (!isCloudEdition(env) && grant.model === SELF_HOSTED_DEFAULT_CATALOG_ID) return { upstream: litellm }
    const models = await (await import('@/lib/model-catalog-server')).modelCatalog()
    if (!catalogModel(grant.model, models)?.pricing) throw new GatewayRefusal(400, 'model_gateway_model_unpriced')
    return { upstream: litellm }
  }
  const { openGatewayApiKey } = await import('@/lib/model-api-keys')
  const opened = await openGatewayApiKey(pool, grant.source.keyId, env).catch((error: unknown) => {
    throw new GatewayRefusal(401, 'model_gateway_key_unavailable', { cause: error })
  })
  const { apiKeyChatBaseUrl, apiKeyEndpoint } = await import('@/lib/model-api-key-providers')
  const anthropic = opened.key.provider === 'anthropic' || (opened.key.provider === 'custom' && opened.key.protocol === 'anthropic')
  const apiBase = anthropic ? apiKeyEndpoint(opened.key, 'claude_code')?.baseUrl : apiKeyChatBaseUrl(opened.key)
  if (!apiBase) throw new GatewayRefusal(400, 'model_gateway_protocol_unsupported')
  return { upstream: { ...litellm, credential: { key: opened.apiKey, provider: anthropic ? 'anthropic' : 'openai', apiBase, chatCompletionsOnly: !anthropic && opened.key.provider !== 'openai' } }, features: opened.features }
}
