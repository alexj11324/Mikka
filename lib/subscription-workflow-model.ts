import type { LanguageModel } from 'ai'
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde'
import { hostedModelSelectionSchema, type HostedModelSelection } from './subscription-model-snapshot'

type V4Model = Extract<LanguageModel, { specificationVersion: 'v4' }>
/** Only non-secret frozen references cross Workflow steps. Custody is resolved
 * in the Node model step, never serialized or loaded by the Workflow VM. */
export class SubscriptionWorkflowModel implements V4Model {
  readonly specificationVersion = 'v4' as const
  readonly provider = 'mikka.subscription'
  readonly supportedUrls = {}
  readonly modelId: string
  private readonly selection: HostedModelSelection
  constructor(selection: HostedModelSelection) {
    this.selection = hostedModelSelectionSchema.parse(selection)
    this.modelId = this.selection.modelId
  }
  static [WORKFLOW_SERIALIZE](value: SubscriptionWorkflowModel) { return { ...value.selection } }
  static [WORKFLOW_DESERIALIZE](value: unknown) { return new SubscriptionWorkflowModel(hostedModelSelectionSchema.parse(value)) }
  async doGenerate(_options: Parameters<V4Model['doGenerate']>[0]): Promise<Awaited<ReturnType<V4Model['doGenerate']>>> {
    throw new Error('subscription_stream_required')
  }
  async doStream(options: Parameters<V4Model['doStream']>[0]) {
    'use step'
    // The SDK's doStreamStep calls this in Node, where a step-to-step call
    // is a normal call. The directive also removes custody imports from the
    // Workflow VM bundle; no provider backend crosses the serde boundary.
    const { resolveSubscriptionWorkflowModel } = await import('./subscription-workflow-model-runtime')
    const model = await resolveSubscriptionWorkflowModel(this.selection, options.abortSignal)
    if (typeof model === 'string' || model.specificationVersion !== 'v4') throw new Error('subscription_model_unavailable')
    return model.doStream(options)
  }
}
