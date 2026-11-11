import 'server-only'
import { selfHostedDefaultModelConfig } from '@/lib/default-model-config'
import { defaultModelTarget } from '@/lib/default-model'
import { selfHostedDefaultModel } from './self-hosted-model'
import { randomUUID } from 'node:crypto'
import { gateway, type LanguageModel } from 'ai'
import { modelAdmission } from '@/lib/model-admission/runtime'
import { GATEWAY_MODEL_ENDPOINT, managedGatewayOptions, ModelAdmissionError, ZEROCAT_MODEL_ENDPOINT, type GatewayAdmission } from '@/lib/model-admission/contract'
import { hostedBillingScope } from './context'
import { checkAbuseAlerts } from './alerts'
import { canUseMikkaPaid, hostedUsage as defaultHostedUsage } from './runtime'
import type { HostedUsageStore } from './store'
import { withSharedCredits } from '@/lib/credit-shares'
import { COORDINATOR_MODEL } from '@/lib/coordinator/model'
import { observedModel, recordAiRoute, recordAiUsage, type AiMetadata } from '@/lib/tracing/ai'
import { modelTokenUsage } from '@/lib/model-call-timing'
import { createZeroCatModel, gatewayCredential, pauseZeroCat, recordModelRoute, zeroCatConfig, zeroCatCost, zeroCatErrorStatus, zeroCatFailureReason, zeroCatPaused, ZEROCAT_FIRST_TOKEN_TIMEOUT_MS, type ZeroCatFallbackReason } from './zerocat'
import {
  gatewayCost,
  gatewayGenerationId,
  HOSTED_CALL_TIMEOUT_MS,
  PaidResourceError,
} from './policy'
type Model = Extract<LanguageModel, { specificationVersion: 'v4' }>

const trustedGatewayModels = new WeakSet<Model>()
/** Server-owned billing adapter. Callers cannot provide this through model options. */
export interface HostedModelBilling {
  usage: Pick<HostedUsageStore, 'metered' | 'reserve' | 'settle' | 'recordGeneration'>
  admit(workspaceId: string): Promise<unknown>
}
export const HOSTED_MODEL_BILLING_VERSION = 1
/** Server-owned transport. Neither redirects nor a caller proxy can move data. */
export async function createTrustedGatewayModel(modelId: string, apiKey?: string): Promise<Model> {
  const { createGateway } = await import('ai')
  const client = createGateway({ baseURL: GATEWAY_MODEL_ENDPOINT, ...(apiKey ? { apiKey } : {}),
    fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }) })
  const model = client(modelId)
  trustedGatewayModels.add(model)
  return model
}
/**
 * The default model (COORDINATOR_MODEL) goes to ZeroCat first and to its AI
 * Gateway route only as a fallback; every other hosted model id keeps Gateway.
 */
export function isZeroCatModel(modelId: string) { return modelId === COORDINATOR_MODEL }

/** Whether a ZeroCat admission refusal leaves the Gateway fallback to decide. */
const routeDenied = (error: unknown) => error instanceof ModelAdmissionError && error.code === 'modelRouteDenied'

/**
 * Admission for a hosted model before any paid work. The default model passes
 * when either of its routes (ZeroCat, else Gateway) is admitted.
 */
export async function admitHostedModel(scope: { workspaceId: string; ownerId?: string }, modelId: string,
  options: { signal?: AbortSignal; auditAllowed?: boolean } = {}): Promise<GatewayAdmission | null> {
  const billing = hostedBillingScope.getStore()
  const ownerId = scope.ownerId ?? (billing?.workspaceId === scope.workspaceId ? billing.ownerId : undefined)
  const target = isZeroCatModel(modelId) ? await defaultModelTarget(ownerId) : null
  if (target?.kind === 'cloud') { await modelAdmission.selfHosted({ ...scope, ownerId }, modelId, `${target.serviceUrl}/v1/models`, options); return null }
  const selfHosted = isZeroCatModel(modelId) ? selfHostedDefaultModelConfig() : null
  if (selfHosted) { await modelAdmission.selfHosted(scope, selfHosted.modelId, selfHosted.baseURL, options); return null }
  if (isZeroCatModel(modelId) && zeroCatConfig()) {
    try { await modelAdmission.zeroCat(scope, modelId, ZEROCAT_MODEL_ENDPOINT, options); return null }
    catch (error) { if (!routeDenied(error)) throw error }
  }
  return modelAdmission.gateway(scope, modelId, GATEWAY_MODEL_ENDPOINT, options)
}

type CallArgs = Parameters<Model['doGenerate']>[0]
type StreamPart = Awaited<ReturnType<Model['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never
/** The first part a consumer could act on; before it the call can still change provider. */
const COMMITTED = new Set(['text-delta', 'reasoning-delta', 'tool-input-start', 'tool-input-delta', 'tool-call', 'tool-result', 'file', 'source'])

/** Every SDK tool step reaches this model boundary, including compaction. */
export async function hostedModel(
  workspaceId: string,
  modelId: string,
  provider?: Model,
  ownerId?: string,
  metadataOrBilling: AiMetadata | HostedModelBilling = {},
): Promise<Model> {
  const billingAdapter = 'usage' in metadataOrBilling ? metadataOrBilling as HostedModelBilling : undefined
  const metadata: AiMetadata = billingAdapter ? {} : metadataOrBilling as AiMetadata
  const hostedUsage = billingAdapter?.usage ?? defaultHostedUsage
  const billing = hostedBillingScope.getStore()
  const scope = { workspaceId, ownerId: ownerId ?? (billing?.workspaceId === workspaceId ? billing.ownerId : undefined) }
  const target = isZeroCatModel(modelId) ? await defaultModelTarget(scope.ownerId) : null
  if (target?.kind === 'cloud' && scope.ownerId) {
    if (provider) throw new ModelAdmissionError('modelRouteDenied')
    return observedModel(await (await import('@/lib/cloud-services/model')).cloudDefaultModel({ ...scope, ownerId: scope.ownerId }, target.serviceUrl), { ...metadata, userId: scope.ownerId, route: 'self_hosted' })
  }
  if (isZeroCatModel(modelId) && selfHostedDefaultModelConfig()) {
    if (provider) throw new ModelAdmissionError('modelRouteDenied')
    return observedModel(selfHostedDefaultModel(scope), { ...metadata, userId: scope.ownerId, route: 'self_hosted' })
  }
  const billingPrincipal = await withSharedCredits(workspaceId, async payer => {
    await (billingAdapter?.admit ?? canUseMikkaPaid)(payer)
    return { payer, organizationId: hostedBillingScope.getStore()?.billingOrganizationId ?? null }
  })
  const zeroCat = isZeroCatModel(modelId)
  // The default model's fallback is its own Gateway route; a caller may hand in
  // only the trusted Gateway transport for it, never an arbitrary provider.
  if (zeroCat && provider && !trustedGatewayModels.has(provider)) throw new ModelAdmissionError('modelRouteDenied')
  let primary: Model | undefined, unavailable: ZeroCatFallbackReason | undefined
  if (zeroCat) {
    try { primary = createZeroCatModel() }
    catch (error) { unavailable = error instanceof PaidResourceError && error.detail === 'zerocat_endpoint_unexpected' ? 'endpoint_unexpected' : 'unconfigured' }
  }
  const model = provider ?? gateway(modelId)
  let managed: Model | undefined
  const executionModel = async (admission: GatewayAdmission | null) => {
    if (!admission) return model
    if (provider && !trustedGatewayModels.has(provider)) throw new ModelAdmissionError('modelRouteDenied')
    return provider ?? (managed ??= await createTrustedGatewayModel(modelId))
  }
  /** True when ZeroCat may serve this call; false sends it to the Gateway fallback. */
  const admitZeroCat = async (signal: AbortSignal | undefined, auditAllowed?: boolean) => {
    if (!primary) return false
    try { await modelAdmission.zeroCat(scope, modelId, ZEROCAT_MODEL_ENDPOINT, { signal, auditAllowed }); return true }
    catch (error) { if (routeDenied(error)) return false; throw error }
  }
  const admitGateway = (signal: AbortSignal | undefined, auditAllowed?: boolean) =>
    modelAdmission.gateway(scope, modelId, GATEWAY_MODEL_ENDPOINT, { signal, auditAllowed })
  const reserve = async (id: string, args: CallArgs) => {
    if (!zeroCat || !await admitZeroCat(args.abortSignal, false)) await executionModel(await admitGateway(args.abortSignal, false))
    // An input-size boundary, not a prepaid or estimated-cost balance check.
    const promptBytes = Buffer.byteLength(
      JSON.stringify({ prompt: args.prompt, tools: args.tools }),
    )
    if (promptBytes > 16 * 1024 * 1024)
      throw new PaidResourceError('usage_cost_unavailable')
    await withSharedCredits(workspaceId, payer => hostedUsage.reserve(payer, modelId, id, process.env), billingPrincipal)
  }
  const bounded = (value: CallArgs, signals: AbortSignal[] = []) => ({
    maxOutputTokens: Math.min(value.maxOutputTokens ?? 4096, 4096),
    abortSignal: AbortSignal.any([
      AbortSignal.timeout(HOSTED_CALL_TIMEOUT_MS),
      ...(value.abortSignal ? [value.abortSignal] : []),
      ...signals,
    ]),
  })
  const options = (value: CallArgs, admission: GatewayAdmission | null) => ({
    ...value,
    providerOptions: {
      ...value.providerOptions,
      gateway: admission ? { ...managedGatewayOptions(admission), user: workspaceId } : { ...value.providerOptions?.gateway, user: workspaceId },
    },
    ...bounded(value),
  })
  // Gateway routing options mean nothing to ZeroCat, and a caller's must not reach it.
  const zeroCatOptions = (value: CallArgs, signals: AbortSignal[] = []) => ({ ...value, providerOptions: withoutGatewayOptions(value.providerOptions), ...bounded(value, signals) })
  const cancelled = (args: CallArgs) => {
    if (args.abortSignal?.aborted) throw args.abortSignal.reason ?? new DOMException('Model request cancelled', 'AbortError')
  }
  const fallbackFrom = (args: CallArgs, error: unknown, firstTokenTimedOut = false): ZeroCatFallbackReason => {
    // A person's stop or the caller's own deadline ends the call; it is not a ZeroCat failure.
    cancelled(args)
    // Later calls in this instance skip a failing ZeroCat for a while instead of each waiting on it.
    pauseZeroCat()
    return zeroCatFailureReason(error, firstTokenTimedOut)
  }
  const route = (served: 'zerocat' | 'gateway', reason?: ZeroCatFallbackReason, error?: unknown, metadata?: unknown, attemptMs?: number) => {
    recordAiRoute({ route: served, fallbackReason: reason, zeroCatMs: attemptMs })
    if (zeroCat) recordModelRoute({ model: modelId, route: served, reason, error, attemptMs, status: zeroCatErrorStatus(error), credential: served === 'gateway' ? gatewayCredential(metadata) : undefined })
  }
  /** Why ZeroCat is skipped before trying it, or undefined to try it. */
  const skipZeroCat = () => unavailable ?? (zeroCatPaused() ? 'paused' as const : undefined)
  return observedModel(new Proxy(model, {
    get(target, key) {
      if (key === 'doGenerate')
        return async (args: CallArgs) => {
          const id = randomUUID()
          await reserve(id, args)
          let requestStarted = false
          let attemptMs: number | undefined
          try {
            if (hostedUsage.metered !== false) await checkAbuseAlerts()
            let reason = skipZeroCat(), failure: unknown
            let result: Awaited<ReturnType<Model['doGenerate']>> | undefined
            if (zeroCat && !reason) {
              if (await admitZeroCat(args.abortSignal)) {
                const prepared = zeroCatOptions(args)
                if (prepared.abortSignal.aborted) throw new DOMException('Model request cancelled', 'AbortError')
                requestStarted = true
                const started = Date.now()
                try { result = await primary!.doGenerate(prepared) }
                catch (error) { reason = fallbackFrom(args, error); failure = error }
                finally { attemptMs = Date.now() - started }
              } else reason = 'route_denied'
            }
            const served = result ? 'zerocat' : 'gateway'
            recordAiRoute({ route: served, fallbackReason: reason, zeroCatMs: attemptMs })
            if (!result) {
              const admission = await admitGateway(args.abortSignal)
              const selected = await executionModel(admission)
              const prepared = options(args, admission)
              if (prepared.abortSignal.aborted) throw new DOMException('Model request cancelled', 'AbortError')
              requestStarted = true
              result = await selected.doGenerate(prepared)
            }
            route(served, reason, failure, result.providerMetadata, attemptMs)
            const cost = served === 'zerocat' ? zeroCatCost(result.usage) : gatewayCost(result.providerMetadata)
            recordAiUsage(result.usage)
            recordAiRoute({ totalCostUsd: cost === null ? null : cost / 1_000_000 })
            const tokens = modelTokenUsage(result.usage)
            await hostedUsage.settle(
              id,
              cost,
              result.usage.inputTokens.total ?? 0,
              result.usage.outputTokens.total ?? 0,
              served === 'gateway' ? gatewayGenerationId(result.providerMetadata) : undefined,
              { read: tokens.cacheReadTokens, write: tokens.cacheWriteTokens },
            )
            if (hostedUsage.metered !== false) await checkAbuseAlerts()
            if (hostedUsage.metered !== false && cost === null)
              throw new PaidResourceError('usage_cost_unavailable')
            return result
          } catch (error) {
            await hostedUsage.settle(id, requestStarted ? null : 0)
            throw error
          }
        }
      if (key === 'doStream')
        return async (args: Parameters<Model['doStream']>[0]) => {
          const id = randomUUID()
          await reserve(id, args)
          let requestStarted = false
          let attemptMs: number | undefined
          try {
            if (hostedUsage.metered !== false) await checkAbuseAlerts()
            let reason = skipZeroCat(), failure: unknown
            let opened: { result: Awaited<ReturnType<Model['doStream']>>; reader: ReadableStreamDefaultReader<StreamPart>; buffered: StreamPart[] } | undefined
            if (zeroCat && !reason) {
              if (await admitZeroCat(args.abortSignal)) {
                const firstToken = new AbortController()
                const timer = setTimeout(() => firstToken.abort(new DOMException('ZeroCat sent no first token in time', 'TimeoutError')), ZEROCAT_FIRST_TOKEN_TIMEOUT_MS)
                const prepared = zeroCatOptions(args, [firstToken.signal])
                if (prepared.abortSignal.aborted) { clearTimeout(timer); throw new DOMException('Model request cancelled', 'AbortError') }
                requestStarted = true
                let reader: ReadableStreamDefaultReader<StreamPart> | undefined
                const started = Date.now()
                try {
                  const result = await primary!.doStream(prepared)
                  reader = result.stream.getReader()
                  // Hold everything up to the first token: until then nothing has
                  // reached the consumer, so a failure can still go to Gateway.
                  const buffered: StreamPart[] = []
                  for (;;) {
                    const { value, done } = await reader.read()
                    if (done) break
                    if (value.type === 'error') throw value.error
                    buffered.push(value)
                    if (COMMITTED.has(value.type) || value.type === 'finish') break
                  }
                  opened = { result, reader, buffered }
                } catch (error) {
                  void reader?.cancel(error).catch(() => {})
                  reason = fallbackFrom(args, error, firstToken.signal.aborted)
                  failure = error
                } finally { clearTimeout(timer); attemptMs = Date.now() - started }
              } else reason = 'route_denied'
            }
            const served = opened ? 'zerocat' : 'gateway'
            recordAiRoute({ route: served, fallbackReason: reason, zeroCatMs: attemptMs })
            if (!opened) {
              const admission = await admitGateway(args.abortSignal)
              const selected = await executionModel(admission)
              const prepared = options(args, admission)
              if (prepared.abortSignal.aborted) throw new DOMException('Model request cancelled', 'AbortError')
              requestStarted = true
              const result = await selected.doStream(prepared)
              opened = { result, reader: result.stream.getReader(), buffered: [] }
            }
            const { result, reader, buffered } = opened
            let finished = false
            let consumerCancelled = false
            let generationId: string | undefined
            let routed = false
            const interrupt = async (reason: unknown) => {
              // Stop provider work immediately, even when accounting is waiting
              // for a database connection or row lock. Still await both outcomes.
              const [upstream, settlement] = await Promise.allSettled([
                reader.cancel(reason),
                finished ? Promise.resolve() : hostedUsage.settle(id, null, 0, 0, generationId),
              ])
              if (settlement.status === 'rejected') throw settlement.reason
              if (upstream.status === 'rejected') throw upstream.reason
            }
            if (served === 'zerocat') { route('zerocat', undefined, undefined, undefined, attemptMs); routed = true }
            return {
              ...result,
              stream: new ReadableStream({
                async pull(controller) {
                  try {
                    const { value: chunk, done } = buffered.length ? { value: buffered.shift()!, done: false } : await reader.read()
                    if (done) {
                      if (!routed) { route(served, reason, failure, undefined, attemptMs); routed = true }
                      if (!finished && !consumerCancelled) await hostedUsage.settle(id, null, 0, 0, generationId)
                      if (!consumerCancelled) controller.close()
                      return
                    }
                    // Gateway exposes its lookup ID on the first content chunk,
                    // before a finish receipt can be lost to interruption.
                    if (served === 'gateway' && chunk.type !== 'finish' && 'providerMetadata' in chunk) {
                      const observed = gatewayGenerationId(chunk.providerMetadata)
                      if (observed && observed !== generationId) {
                        await hostedUsage.recordGeneration(id, observed)
                        generationId = observed
                      }
                    }
                    if (chunk.type === 'finish') {
                      if (!routed) { route(served, reason, failure, chunk.providerMetadata, attemptMs); routed = true }
                      const cost = served === 'zerocat' ? zeroCatCost(chunk.usage) : gatewayCost(chunk.providerMetadata)
                      recordAiUsage(chunk.usage)
                      recordAiRoute({ totalCostUsd: cost === null ? null : cost / 1_000_000 })
                      const tokens = modelTokenUsage(chunk.usage)
                      await hostedUsage.settle(
                        id,
                        cost,
                        chunk.usage.inputTokens.total ?? 0,
                        chunk.usage.outputTokens.total ?? 0,
                        served === 'gateway' ? gatewayGenerationId(chunk.providerMetadata) ?? generationId : undefined,
                        { read: tokens.cacheReadTokens, write: tokens.cacheWriteTokens },
                      )
                      finished = true
                      if (hostedUsage.metered !== false) await checkAbuseAlerts()
                      if (hostedUsage.metered !== false && cost === null)
                        throw new PaidResourceError('usage_cost_unavailable')
                    }
                    if (!consumerCancelled) controller.enqueue(chunk)
                  } catch (error) {
                    let failure = error
                    try { await interrupt(error) } catch (cleanupError) { failure = cleanupError }
                    if (!consumerCancelled) controller.error(failure)
                  }
                },
                async cancel(reason) {
                  consumerCancelled = true
                  await interrupt(reason)
                },
              }),
            }
          } catch (error) {
            await hostedUsage.settle(id, requestStarted ? null : 0)
            throw error
          }
        }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }), { ...metadata, modelId, userId: scope.ownerId, route: zeroCat && primary ? 'zerocat' : 'gateway' })
}

function withoutGatewayOptions(options: CallArgs['providerOptions']) {
  if (!options) return undefined
  const { gateway: _gateway, ...rest } = options
  return rest
}
