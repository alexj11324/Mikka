import type { LanguageModel } from 'ai'
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde'
type Model = Extract<LanguageModel, { specificationVersion: 'v4' }>
/** Non-secret billing scope crosses durable steps; the provider never does. */
export class HostedWorkflowModel implements Model {
  readonly specificationVersion = 'v4' as const
  readonly provider = 'mikka.hosted'
  readonly supportedUrls = {}
  constructor(
    readonly ownerId: string,
    readonly botId: string | null,
    readonly modelId: string,
  ) {}
  static [WORKFLOW_SERIALIZE](value: HostedWorkflowModel) {
    return {
      ownerId: value.ownerId,
      botId: value.botId,
      modelId: value.modelId,
    }
  }
  static [WORKFLOW_DESERIALIZE](value: {
    ownerId: string
    botId: string | null
    modelId: string
  }) {
    return new HostedWorkflowModel(value.ownerId, value.botId, value.modelId)
  }
  async doGenerate(options: Parameters<Model['doGenerate']>[0]) {
    'use step'
    const { executionWorkspace } = await import('../execution-settings')
    const { hostedModel } = await import('./model')
    return (
      await hostedModel(
        await executionWorkspace(this.ownerId, this.botId),
        this.modelId,
        undefined,
        this.ownerId,
      )
    ).doGenerate(options)
  }
  async doStream(options: Parameters<Model['doStream']>[0]) {
    'use step'
    const { executionWorkspace } = await import('../execution-settings')
    const { hostedModel } = await import('./model')
    return (
      await hostedModel(
        await executionWorkspace(this.ownerId, this.botId),
        this.modelId,
        undefined,
        this.ownerId,
      )
    ).doStream(options)
  }
}
