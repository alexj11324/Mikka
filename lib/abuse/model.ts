import 'server-only'
import { randomUUID } from 'node:crypto'
import { gateway, type LanguageModel } from 'ai'
import { modelAdmission } from '@/lib/model-admission/runtime'
import { GATEWAY_MODEL_ENDPOINT, managedGatewayOptions, ModelAdmissionError, type GatewayAdmission } from '@/lib/model-admission/contract'
import { hostedBillingScope } from './context'
import { checkAbuseAlerts } from './alerts'
import { canUseMikkaPaid, hostedUsage } from './runtime'
import {
  gatewayCost,
  gatewayGenerationId,
  HOSTED_CALL_TIMEOUT_MS,
  PaidResourceError,
} from './policy'
type Model = Extract<LanguageModel, { specificationVersion: 'v4' }>
const trustedGatewayModels = new WeakSet<Model>()
/** Server-owned transport. Neither redirects nor a caller proxy can move data. */
export async function createTrustedGatewayModel(modelId: string, apiKey?: string): Promise<Model> {
  const { createGateway } = await import('ai')
  const client = createGateway({ baseURL: GATEWAY_MODEL_ENDPOINT, ...(apiKey ? { apiKey } : {}),
    fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }) })
  const model = client(modelId)
  trustedGatewayModels.add(model)
  return model
}
/** Every SDK tool step reaches this model boundary, including compaction. */
export async function hostedModel(
  workspaceId: string,
  modelId: string,
  provider?: Model,
  ownerId?: string,
): Promise<Model> {
  await canUseMikkaPaid(workspaceId)
  const model = provider ?? gateway(modelId)
  const billing = hostedBillingScope.getStore()
  const scope = { workspaceId, ownerId: ownerId ?? (billing?.workspaceId === workspaceId ? billing.ownerId : undefined) }
  let managed: Model | undefined
  const executionModel = async (admission: GatewayAdmission | null) => {
    if (!admission) return model
    if (provider && !trustedGatewayModels.has(provider)) throw new ModelAdmissionError('modelRouteDenied')
    return provider ?? (managed ??= await createTrustedGatewayModel(modelId))
  }
  const reserve = async (
    id: string,
    args: Parameters<Model['doGenerate']>[0],
  ) => {
    const admission = await modelAdmission.gateway(scope, modelId, GATEWAY_MODEL_ENDPOINT, { signal: args.abortSignal, auditAllowed: false })
    await executionModel(admission)
    // An input-size boundary, not a prepaid or estimated-cost balance check.
    const promptBytes = Buffer.byteLength(
      JSON.stringify({ prompt: args.prompt, tools: args.tools }),
    )
    if (promptBytes > 16 * 1024 * 1024)
      throw new PaidResourceError('usage_cost_unavailable')
    await hostedUsage.reserve(workspaceId, modelId, id, process.env)
    await checkAbuseAlerts()
  }
  const options = (value: Parameters<Model['doGenerate']>[0], admission: GatewayAdmission | null) => ({
    ...value,
    providerOptions: {
      ...value.providerOptions,
      gateway: admission ? { ...managedGatewayOptions(admission), user: workspaceId } : { ...value.providerOptions?.gateway, user: workspaceId },
    },
    maxOutputTokens: Math.min(value.maxOutputTokens ?? 4096, 4096),
    abortSignal: AbortSignal.any([
      AbortSignal.timeout(HOSTED_CALL_TIMEOUT_MS),
      ...(value.abortSignal ? [value.abortSignal] : []),
    ]),
  })
  return new Proxy(model, {
    get(target, key) {
      if (key === 'doGenerate')
        return async (args: Parameters<Model['doGenerate']>[0]) => {
          const id = randomUUID()
          await reserve(id, args)
          try {
            const admission = await modelAdmission.gateway(scope, modelId, GATEWAY_MODEL_ENDPOINT, { signal: args.abortSignal })
            const selected = await executionModel(admission)
            const result = await selected.doGenerate(options(args, admission))
            const cost = gatewayCost(result.providerMetadata)
            await hostedUsage.settle(
              id,
              cost,
              result.usage.inputTokens.total ?? 0,
              result.usage.outputTokens.total ?? 0,
              gatewayGenerationId(result.providerMetadata),
            )
            await checkAbuseAlerts()
            if (cost === null)
              throw new PaidResourceError('usage_cost_unavailable')
            return result
          } catch (error) {
            await hostedUsage.settle(id, null)
            throw error
          }
        }
      if (key === 'doStream')
        return async (args: Parameters<Model['doStream']>[0]) => {
          const id = randomUUID()
          await reserve(id, args)
          try {
            const admission = await modelAdmission.gateway(scope, modelId, GATEWAY_MODEL_ENDPOINT, { signal: args.abortSignal })
            const selected = await executionModel(admission)
            const result = await selected.doStream(options(args, admission))
            let finished = false
            return {
              ...result,
              stream: result.stream.pipeThrough(
                new TransformStream({
                  async transform(chunk, controller) {
                    if (chunk.type === 'finish') {
                      finished = true
                      const cost = gatewayCost(chunk.providerMetadata)
                      await hostedUsage.settle(
                        id,
                        cost,
                        chunk.usage.inputTokens.total ?? 0,
                        chunk.usage.outputTokens.total ?? 0,
                        gatewayGenerationId(chunk.providerMetadata),
                      )
                      await checkAbuseAlerts()
                      if (cost === null)
                        throw new PaidResourceError('usage_cost_unavailable')
                    }
                    controller.enqueue(chunk)
                  },
                  async flush() {
                    if (!finished) await hostedUsage.settle(id, null)
                  },
                }),
              ),
            }
          } catch (error) {
            await hostedUsage.settle(id, null)
            throw error
          }
        }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
