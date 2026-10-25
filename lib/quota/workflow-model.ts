import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from '@workflow/serde'
import type { gateway } from 'ai'

type GatewayModel = ReturnType<typeof gateway.languageModel>
type CallOptions = Parameters<GatewayModel['doGenerate']>[0]

/** Only identifiers cross the durable step boundary; provider clients and
 * database handles are constructed at the actual model invocation. */
export class QuotaWorkflowModel {
  readonly specificationVersion = 'v4' as const
  readonly provider = 'gateway'
  readonly supportedUrls = {}
  constructor(readonly ownerId: string, readonly modelId: string, readonly operationKey: string) {}
  static [WORKFLOW_SERIALIZE](model: QuotaWorkflowModel) {
    return { ownerId: model.ownerId, modelId: model.modelId, operationKey: model.operationKey }
  }
  static [WORKFLOW_DESERIALIZE](data: { ownerId: string; modelId: string; operationKey: string }) {
    return new QuotaWorkflowModel(data.ownerId, data.modelId, data.operationKey)
  }
  async doGenerate(options: CallOptions) {
    'use step'
    const { gateway } = await import('ai')
    const { beginQuota, quotaFailure, tenantQuotas } = await import('./runtime')
    const reservation = await beginQuota({ ownerId: this.ownerId, key: this.operationKey, resource: 'coordinator.model', binding: { model: this.modelId, prompt: options.prompt, tools: options.tools } })
    let result: Awaited<ReturnType<GatewayModel['doGenerate']>>
    try {
      result = await gateway.languageModel(this.modelId).doGenerate({ ...options, abortSignal: AbortSignal.any([...(options.abortSignal ? [options.abortSignal] : []), AbortSignal.timeout(270000)]) })
    } catch (error) {
      const failure = quotaFailure(error)
      await tenantQuotas.finish(this.ownerId, reservation.id, failure.outcome, undefined, failure.retryAfter)
      throw error
    }
    await tenantQuotas.finish(this.ownerId, reservation.id, 'settled', { inputTokens: result.usage.inputTokens.total, outputTokens: result.usage.outputTokens.total })
    return result
  }
  async doStream(_options: Parameters<GatewayModel['doStream']>[0]): Promise<Awaited<ReturnType<GatewayModel['doStream']>>> {
    throw new Error('quotaStreamingUnsupported: Coordinator uses durable generate')
  }
}
