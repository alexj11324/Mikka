import 'server-only'
import { generateText, streamText, type ModelMessage } from 'ai'
import { resolveFrozenHostedModel, type HostedModelDependencies, type HostedModelScope, type HostedRuntimeSnapshot } from '../subscription-model-snapshot'
import { SUMMARY_INSTRUCTIONS } from './context'

/** Compression is part of the same execution, not a separate default-model
 * task. Resolution/auth errors propagate before a summary can be saved. */
export async function compactWithFrozenModel(scope: HostedModelScope, runtime: HostedRuntimeSnapshot, messages: ModelMessage[], dependencies: HostedModelDependencies, signal?: AbortSignal): Promise<string> {
  const budget = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])])
  const model = await resolveFrozenHostedModel(scope, runtime, dependencies, budget)
  const options = { model, instructions: SUMMARY_INSTRUCTIONS, maxOutputTokens: 4096, maxRetries: 0, abortSignal: budget, messages }
  // The existing subscription worker supports streaming only. There is no
  // catch/default gateway fallback, including after partial output or refusal.
  const result = runtime.modelSelection ? streamText(options) : await generateText(options)
  const text = await result.text
  budget.throwIfAborted()
  if (!text.trim()) throw new Error('compactionModelUnavailable')
  return text
}
