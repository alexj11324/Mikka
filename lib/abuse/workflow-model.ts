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
    readonly actorId: string,
  ) {}
  static [WORKFLOW_SERIALIZE](value: HostedWorkflowModel) {
    return {
      ownerId: value.ownerId,
      botId: value.botId,
      modelId: value.modelId,
      actorId: value.actorId,
    }
  }
  static [WORKFLOW_DESERIALIZE](value: {
    ownerId: string
    botId: string | null
    modelId: string
    actorId: string
  }) {
    return new HostedWorkflowModel(value.ownerId, value.botId, value.modelId, value.actorId)
  }
  async doGenerate(options: Parameters<Model['doGenerate']>[0]) {
    'use step'
    if (!this.actorId || this.actorId !== this.ownerId) throw new Error('verification_required')
    const { executionWorkspace } = await import('../execution-settings')
    const { hostedModel } = await import('./model')
    const { workflowFailureCall } = await import('../workflow-run-failure')
    const { stepIdentity } = await import('../model-call-timing')
    const { APP_BUILD } = await import('../app-build')
    const identity = await stepIdentity()
    return workflowFailureCall(async () => (
      await hostedModel(
        await executionWorkspace(this.ownerId, this.botId),
        this.modelId,
        undefined,
        this.ownerId,
        { operation: this.botId ? 'bot' : 'coordinator' },
      )
    ).doGenerate(options), { runId: identity.workflowRunId, appVersion: APP_BUILD, credential: 'api_key', requestBodyValues: { prompt: options.prompt, tools: options.tools, providerOptions: options.providerOptions, headers: options.headers } })
  }
  async doStream(options: Parameters<Model['doStream']>[0]) {
    'use step'
    if (!this.actorId || this.actorId !== this.ownerId) throw new Error('verification_required')
    const startedAt = Date.now()
    const { executionWorkspace } = await import('../execution-settings')
    const { hostedModel } = await import('./model')
    const { stepIdentity, timedModelStream } = await import('../model-call-timing')
    let requestedAt = Date.now()
    // An Anthropic model caches only at explicit breakpoints; other providers ignore the option (lib/prompt-cache.ts).
    const { withCacheBreakpoints } = await import('../prompt-cache')
    const { workflowFailureStream } = await import('../workflow-run-failure')
    const { APP_BUILD } = await import('../app-build')
    const identity = await stepIdentity()
    const result = await workflowFailureStream(async () => {
      const model = await hostedModel(await executionWorkspace(this.ownerId, this.botId), this.modelId, undefined, this.ownerId, { operation: this.botId ? 'bot' : 'coordinator' })
      requestedAt = Date.now()
      return model.doStream({ ...options, prompt: withCacheBreakpoints(options.prompt, 'anthropic') })
    }, { runId: identity.workflowRunId, appVersion: APP_BUILD, credential: 'api_key', requestBodyValues: { prompt: options.prompt, tools: options.tools, providerOptions: options.providerOptions, headers: options.headers } })
    return timedModelStream(result, { route: 'hosted', model: this.modelId, tools: options.tools?.length ?? 0, startedAt, requestedAt, ...identity })
  }
}
