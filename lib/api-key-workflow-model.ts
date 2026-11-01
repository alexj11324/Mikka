import type { LanguageModel } from 'ai'
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde'
import { apiKeyModelSnapshotSchema, type ApiKeyModelSnapshot } from './subscription-model-snapshot'

type V4Model = Extract<LanguageModel, { specificationVersion: 'v4' }>
/** A workspace-added API-key model. Only the non-secret frozen reference crosses
 * Workflow steps; the key is read and the provider built in the Node model step,
 * never serialized or loaded by the Workflow VM. Mirrors SubscriptionWorkflowModel. */
export class ApiKeyWorkflowModel implements V4Model {
  readonly specificationVersion = 'v4' as const
  readonly provider = 'mikka.apiKey'
  readonly supportedUrls = {}
  readonly modelId: string
  private readonly selection: ApiKeyModelSnapshot
  constructor(selection: ApiKeyModelSnapshot) {
    this.selection = apiKeyModelSnapshotSchema.parse(selection)
    this.modelId = this.selection.modelId
  }
  static [WORKFLOW_SERIALIZE](value: ApiKeyWorkflowModel) { return { ...value.selection } }
  static [WORKFLOW_DESERIALIZE](value: unknown) { return new ApiKeyWorkflowModel(apiKeyModelSnapshotSchema.parse(value)) }
  async doGenerate(options: Parameters<V4Model['doGenerate']>[0]): Promise<Awaited<ReturnType<V4Model['doGenerate']>>> {
    'use step'
    const { resolveApiKeyWorkflowModel } = await import('./api-key-workflow-model-runtime')
    const model = await resolveApiKeyWorkflowModel(this.selection, options.abortSignal)
    return model.doGenerate(options)
  }
  async doStream(options: Parameters<V4Model['doStream']>[0]) {
    'use step'
    // Resolved in Node (the SDK calls this via doStreamStep); the directive also
    // keeps credential/custody imports out of the Workflow VM bundle.
    const { resolveApiKeyWorkflowModel } = await import('./api-key-workflow-model-runtime')
    const model = await resolveApiKeyWorkflowModel(this.selection, options.abortSignal)
    if (model.specificationVersion !== 'v4') throw new Error('api_key_model_unavailable')
    return model.doStream(options)
  }
}
