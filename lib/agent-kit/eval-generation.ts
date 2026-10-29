import { z } from 'zod'

const finalReply = z.strictObject({ text:z.string().max(16_000),outcome:z.enum(['answered','blocked','approval_required']) })

/** A parseable partial JSON reply is not a successfully completed generation.
 * This checks transport completion, not the business quality of the answer. */
export async function completedEvaluationReply(result: { text:string|PromiseLike<string>; finishReason:string|PromiseLike<string> }, signal:AbortSignal, failed:()=>boolean) {
  const text=await result.text
  const finishReason=await result.finishReason
  signal.throwIfAborted()
  if(failed() || finishReason!=='stop') throw new Error('agentEvaluationGenerationFailed')
  return finalReply.parse(JSON.parse(text))
}
