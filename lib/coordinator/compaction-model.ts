import 'server-only'
import { generateText, streamText, type ModelMessage } from 'ai'
import { resolveFrozenHostedModel, type HostedModelDependencies, type HostedModelScope, type HostedRuntimeSnapshot } from '../subscription-model-snapshot'
import { SUMMARY_INSTRUCTIONS } from './context'

/** Compression is part of the same execution, not a separate default-model
 * task. Resolution/auth errors propagate before a summary can be saved. */
export async function compactWithFrozenModel(scope: HostedModelScope, runtime: HostedRuntimeSnapshot, messages: ModelMessage[], dependencies: HostedModelDependencies, signal?: AbortSignal, summaryOptions = { instructions: SUMMARY_INSTRUCTIONS, maxOutputTokens: 4096 }): Promise<string> {
  const budget = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])])
  const model = await resolveFrozenHostedModel(scope, runtime, dependencies, budget)
  let failed = false
  const options = { ...summaryOptions, model, maxRetries: 0, abortSignal: budget, messages, onError: () => { failed = true } }
  // The existing subscription worker supports streaming only. There is no
  // catch/default gateway fallback, including after partial output or refusal.
  const result = runtime.modelSelection ? streamText(options) : await generateText(options)
  const text = await result.text
  const finishReason = await result.finishReason
  budget.throwIfAborted()
  // A stream can resolve partial text after an error/length/filter outcome.
  // It must not advance the persisted summary cursor and hide old context.
  if (failed || !text.trim() || finishReason !== 'stop') throw new Error('compactionModelUnavailable')
  return text
}
