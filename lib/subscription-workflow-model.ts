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
    const startedAt = Date.now()
    const { resolveSubscriptionWorkflowModel } = await import('./subscription-workflow-model-runtime')
    const model = await resolveSubscriptionWorkflowModel(this.selection, options.abortSignal)
    if (typeof model === 'string' || model.specificationVersion !== 'v4') throw new Error('subscription_model_unavailable')
    const { promptPrefix, stepIdentity, timedModelStream } = await import('./model-call-timing')
    const { SubscriptionCallTiming, withSubscriptionTiming } = await import('../packages/daemon/src/subscription-worker-timing')
    const requestedAt = Date.now()
    const subscriptionTiming = new SubscriptionCallTiming()
    // Claude gets its provider breakpoints. Supported Codex subscriptions keep
    // the prepared stable prefix contiguous without extra OAuth request fields.
    const { withCacheBreakpoints, withCodexStablePrefix } = await import('./prompt-cache')
    const key = this.selection.type === 'api_key' ? 'anthropic' : this.selection.route === 'claude_cpa' ? 'openaiCompatible' : null
    const codex = this.selection.type === 'subscription' && this.selection.route === 'codex_cpa'
    const prompt = key ? withCacheBreakpoints(options.prompt, key) : codex ? withCodexStablePrefix(options.prompt, this.modelId) : options.prompt
    const request = prompt === options.prompt ? options : { ...options, prompt }
    const prefix = await promptPrefix(options.prompt, options.tools)
    return timedModelStream(await withSubscriptionTiming(subscriptionTiming, () => model.doStream(request)), { route: 'subscription', model: this.modelId, tools: options.tools?.length ?? 0, startedAt, requestedAt, prefix, subscriptionTiming, ...(codex ? { codexLayoutApplied: prompt !== options.prompt } : {}), ...await stepIdentity() })
  }
}
