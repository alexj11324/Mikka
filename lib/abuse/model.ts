import 'server-only'
import { randomUUID } from 'node:crypto'
import type { LanguageModel } from 'ai'
import { modelAdmission } from '@/lib/model-admission/runtime'
import { ModelAdmissionError } from '@/lib/model-admission/contract'
import { createLiteLLMModel, liteLLMBaseUrl, liteLLMCost, liteLLMGenerationId } from '@/lib/model-gateway/litellm-client'
import { hostedBillingScope } from './context'
import { checkAbuseAlerts } from './alerts'
import { canUseMikkaPaid, hostedUsage as defaultHostedUsage } from './runtime'
import type { HostedUsageStore } from './store'
import { withSharedCredits } from '@/lib/credit-shares'
import { observedModel, recordAiRoute, recordAiUsage, type AiMetadata } from '@/lib/tracing/ai'
import { modelTokenUsage, stepIdentity } from '@/lib/model-call-timing'
import { hostedCallId } from '@/lib/model-gateway/hosted-call-id.mjs'
import { HOSTED_CALL_TIMEOUT_MS, PaidResourceError } from './policy'
type Model = Extract<LanguageModel, { specificationVersion: 'v4' }>

/** Server-owned billing adapter. Callers cannot provide this through model options. */
export interface HostedModelBilling {
  usage: Pick<HostedUsageStore, 'metered' | 'reserve' | 'settle' | 'recordGeneration'>
  admit(workspaceId: string): Promise<unknown>
}
export const HOSTED_MODEL_BILLING_VERSION = 1

/** Admission precedes reservation and every outbound model call. */
export async function admitHostedModel(scope: { workspaceId: string; ownerId?: string }, modelId: string,
  options: { signal?: AbortSignal; auditAllowed?: boolean } = {}) {
  const billing = hostedBillingScope.getStore()
  const ownerId = scope.ownerId ?? (billing?.workspaceId === scope.workspaceId ? billing.ownerId : undefined)
  const endpoint = liteLLMBaseUrl()
  if (!endpoint) throw new ModelAdmissionError('modelRouteDenied')
  return modelAdmission.litellm({ ...scope, ownerId }, modelId, endpoint, options)
}

type CallArgs = Parameters<Model['doGenerate']>[0]
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
  const billingPrincipal = await withSharedCredits(workspaceId, async payer => {
    await (billingAdapter?.admit ?? canUseMikkaPaid)(payer)
    return { payer, organizationId: hostedBillingScope.getStore()?.billingOrganizationId ?? null }
  })
  if (provider) throw new ModelAdmissionError('modelRouteDenied')
  const model = createLiteLLMModel(modelId, { user: workspaceId })
  const forCall = async (id: string) => createLiteLLMModel(modelId, { user: workspaceId, callId: hostedCallId(id, await stepIdentity()) })
  const reserve = async (id: string, args: CallArgs) => {
    await admitHostedModel(scope, modelId, { signal: args.abortSignal, auditAllowed: false })
    // An input-size boundary, not a prepaid or estimated-cost balance check.
    const promptBytes = Buffer.byteLength(
      JSON.stringify({ prompt: args.prompt, tools: args.tools }),
    )
    if (promptBytes > 16 * 1024 * 1024)
      throw new PaidResourceError('usage_cost_unavailable')
    await withSharedCredits(workspaceId, payer => hostedUsage.reserve(payer, modelId, id, process.env), billingPrincipal)
  }
  const bounded = (value: CallArgs) => ({
    maxOutputTokens: Math.min(value.maxOutputTokens ?? 4096, 4096),
    abortSignal: AbortSignal.any([
      AbortSignal.timeout(HOSTED_CALL_TIMEOUT_MS),
      ...(value.abortSignal ? [value.abortSignal] : []),
    ]),
  })
  // Callers cannot replace LiteLLM's routing, credentials or attribution.
  const options = (value: CallArgs) => ({ ...value, headers: undefined, providerOptions: undefined, ...bounded(value) })
  return observedModel(new Proxy(model, {
    get(target, key) {
      if (key === 'doGenerate')
        return async (args: CallArgs) => {
          const id = randomUUID()
          await reserve(id, args)
          let requestStarted = false
          try {
            if (hostedUsage.metered !== false) await checkAbuseAlerts()
            await admitHostedModel(scope, modelId, { signal: args.abortSignal })
            const selected = await forCall(id)
            const prepared = options(args)
            if (prepared.abortSignal.aborted) throw new DOMException('Model request cancelled', 'AbortError')
            requestStarted = true
            const result = await selected.doGenerate(prepared)
            const cost = liteLLMCost(result.providerMetadata)
            recordAiUsage(result.usage)
            recordAiRoute({ totalCostUsd: cost === null ? null : cost / 1_000_000 })
            const tokens = modelTokenUsage(result.usage)
            await hostedUsage.settle(
              id,
              cost,
              result.usage.inputTokens.total ?? 0,
              result.usage.outputTokens.total ?? 0,
              liteLLMGenerationId(result.providerMetadata),
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
          try {
            if (hostedUsage.metered !== false) await checkAbuseAlerts()
            await admitHostedModel(scope, modelId, { signal: args.abortSignal })
            const selected = await forCall(id)
            const prepared = options(args)
            if (prepared.abortSignal.aborted) throw new DOMException('Model request cancelled', 'AbortError')
            requestStarted = true
            const result = await selected.doStream(prepared)
            const reader = result.stream.getReader()
            let finished = false
            let consumerCancelled = false
            let generationId = new Headers(result.response?.headers).get('x-litellm-call-id') ?? undefined
            if (generationId) {
              try { await hostedUsage.recordGeneration(id, generationId) }
              catch (error) { await reader.cancel(error); throw error }
            }
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
            return {
              ...result,
              stream: new ReadableStream({
                async pull(controller) {
                  try {
                    const { value: chunk, done } = await reader.read()
                    if (done) {
                      if (!finished && !consumerCancelled) await hostedUsage.settle(id, null, 0, 0, generationId)
                      if (!consumerCancelled) controller.close()
                      return
                    }
                    // LiteLLM exposes its lookup ID on the first content chunk,
                    // before a finish receipt can be lost to interruption.
                    if (chunk.type !== 'finish' && 'providerMetadata' in chunk) {
                      const observed = liteLLMGenerationId(chunk.providerMetadata)
                      if (observed && observed !== generationId) {
                        await hostedUsage.recordGeneration(id, observed)
                        generationId = observed
                      }
                    }
                    if (chunk.type === 'finish') {
                      const cost = liteLLMCost(chunk.providerMetadata)
                      recordAiUsage(chunk.usage)
                      recordAiRoute({ totalCostUsd: cost === null ? null : cost / 1_000_000 })
                      const tokens = modelTokenUsage(chunk.usage)
                      await hostedUsage.settle(
                        id,
                        cost,
                        chunk.usage.inputTokens.total ?? 0,
                        chunk.usage.outputTokens.total ?? 0,
                        liteLLMGenerationId(chunk.providerMetadata) ?? generationId,
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
  }), { ...metadata, modelId, userId: scope.ownerId, route: 'litellm' })
}
