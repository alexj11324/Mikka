import { threadModelChoice, threadModelKey, type ThreadModelChoice } from './thread-model-choice'
import { z } from 'zod'

const submission = z.object({ requestId: z.uuid(), runId: z.uuid(), text: z.string().min(1).max(10_000), modelChoice: threadModelChoice.optional() }).strict()
export type ThreadReplySubmission = z.infer<typeof submission>

/** A refreshed thread may already show the run started by this request. Keep
 * the original anchor and ID until its immutable text has been acknowledged. */
export function prepareThreadReply(previous: unknown, runId: string, text: string, newId = () => crypto.randomUUID(), modelChoice?: ThreadModelChoice): ThreadReplySubmission {
  const prior = submission.safeParse(previous)
  return prior.success && prior.data.text === text && (prior.data.modelChoice && modelChoice ? threadModelKey(prior.data.modelChoice) === threadModelKey(modelChoice) : prior.data.modelChoice === modelChoice) ? prior.data : submission.parse({ requestId: newId(), runId, text, ...(modelChoice ? { modelChoice } : {}) })
}
