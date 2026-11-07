import 'server-only'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { COORDINATOR_MODEL } from '@/lib/coordinator/model'
import { modelAdmission } from '@/lib/model-admission/runtime'
import { HOSTED_CALL_TIMEOUT_MS, PaidResourceError } from '@/lib/abuse/policy'
import { cloudRequest } from './runtime'

type Model = Extract<LanguageModel, { specificationVersion: 'v4' }>
/** Only Mikka's small default-model calls take this route. Native coding CLIs
 * still receive their real selected credentials and call their provider. */
export function cloudDefaultModel(scope: { workspaceId: string; ownerId: string }, serviceUrl: string): Model {
  const endpoint = `${serviceUrl}/v1/models`
  const model = createOpenAICompatible({ name: 'openai-compatible', baseURL: endpoint, includeUsage: true,
    // Credentials and the endpoint come exclusively from CloudClientStore. SDK
    // headers/provider options cannot replace the actor, payer or destination.
    fetch: (_input, init) => cloudRequest(scope.ownerId, 'models', '/v1/models/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: init?.body, signal: init?.signal,
    }),
  }).chatModel(COORDINATOR_MODEL) as Model
  return new Proxy(model, {
    get(target, key) {
      if (key === 'doGenerate' || key === 'doStream') return async (args: Parameters<Model['doGenerate']>[0]) => {
        if (Buffer.byteLength(JSON.stringify({ prompt: args.prompt, tools: args.tools })) > 16 * 1024 * 1024) throw new PaidResourceError('usage_cost_unavailable')
        await modelAdmission.selfHosted(scope, COORDINATOR_MODEL, endpoint, { signal: args.abortSignal })
        const bounded = { ...args, providerOptions: {}, maxOutputTokens: Math.min(args.maxOutputTokens ?? 4096, 4096),
          abortSignal: AbortSignal.any([AbortSignal.timeout(HOSTED_CALL_TIMEOUT_MS), ...(args.abortSignal ? [args.abortSignal] : [])]) }
        return key === 'doGenerate' ? target.doGenerate(bounded) : target.doStream(bounded)
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
