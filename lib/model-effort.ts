import type { LanguageModel } from 'ai'
import { supportedModelEfforts, type ModelRoutingEffort } from './model-routing'

type Model = Extract<LanguageModel, { specificationVersion: 'v4' }>
type CallOptions = Parameters<Model['doStream']>[0]

/** The harness family whose effort catalogue a chat model belongs to (lib/model-routing.ts). */
function familyOf(modelId: string): 'claude_code' | 'codex' {
  return /(^|\/)(gpt|o\d)/i.test(modelId) ? 'codex' : 'claude_code'
}

/** The provider options that carry a reasoning effort: OpenAI's and an OpenAI-compatible route's `reasoningEffort`, Anthropic's `effort`. */
export function effortProviderOptions(effort: ModelRoutingEffort): NonNullable<CallOptions['providerOptions']> {
  return { openai: { reasoningEffort: effort }, openaiCompatible: { reasoningEffort: effort }, anthropic: { effort } }
}

/**
 * The Bot's chat model with its saved reasoning effort (bot_model_choices.effort)
 * on every call. A model whose catalogue does not list that effort, or no
 * effort, gets the model unchanged: the provider's default, never a refusal.
 */
export function withModelEffort(model: Model, effort: ModelRoutingEffort | null | undefined): Model {
  const id = model.modelId.split('/').pop() ?? model.modelId
  if (!effort || !supportedModelEfforts(id, familyOf(id)).includes(effort)) return model
  const extra = effortProviderOptions(effort)
  const merge = (options: CallOptions): CallOptions => {
    const providerOptions = { ...options.providerOptions }
    for (const [key, value] of Object.entries(extra)) providerOptions[key] = { ...value, ...providerOptions[key] }
    return { ...options, providerOptions }
  }
  return {
    specificationVersion: 'v4', provider: model.provider, modelId: model.modelId, supportedUrls: model.supportedUrls,
    doStream: options => model.doStream(merge(options)),
    doGenerate: options => model.doGenerate(merge(options)),
  }
}
