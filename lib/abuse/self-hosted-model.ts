import 'server-only'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { modelAdmission } from '@/lib/model-admission/runtime'
import { selfHostedDefaultModelConfig } from '@/lib/default-model-config'
import { ModelAdmissionError } from '@/lib/model-admission/contract'
import { HOSTED_CALL_TIMEOUT_MS, PaidResourceError } from './policy'

type Model = Extract<LanguageModel, { specificationVersion: 'v4' }>
/** The administrator's provider is contacted directly; no Mikka billing or
 * fallback can send this call to another service. Admission is rechecked at
 * each SDK tool step, as it is for hosted and subscription transports. */
export function selfHostedDefaultModel(scope: { workspaceId: string; ownerId?: string }): Model {
  const config = selfHostedDefaultModelConfig()
  if (!config) throw new ModelAdmissionError('modelRouteDenied')
  const model = createOpenAICompatible({ name: 'openai-compatible', baseURL: config.baseURL, apiKey: config.apiKey, includeUsage: true,
    fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }) }).chatModel(config.modelId) as Model
  return new Proxy(model, {
    get(target, key) {
      if (key === 'doGenerate' || key === 'doStream') return async (args: Parameters<Model['doGenerate']>[0]) => {
        if (Buffer.byteLength(JSON.stringify({ prompt: args.prompt, tools: args.tools })) > 16 * 1024 * 1024) throw new PaidResourceError('usage_cost_unavailable')
        await modelAdmission.selfHosted(scope, config.modelId, config.baseURL, { signal: args.abortSignal })
        const { gateway: _gateway, ...providerOptions } = args.providerOptions ?? {}
        const bounded = { ...args, providerOptions, maxOutputTokens: Math.min(args.maxOutputTokens ?? 4096, 4096),
          abortSignal: AbortSignal.any([AbortSignal.timeout(HOSTED_CALL_TIMEOUT_MS), ...(args.abortSignal ? [args.abortSignal] : [])]) }
        return key === 'doGenerate' ? target.doGenerate(bounded) : target.doStream(bounded)
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
