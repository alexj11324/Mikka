import 'server-only'
import { generateText, NoObjectGeneratedError, NoOutputGeneratedError, Output } from 'ai'
import { z } from 'zod'
import { HOSTED_CALL_TIMEOUT_MS } from '@/lib/abuse/policy'
import { TITLE_MODEL } from '@/lib/coordinator/model'
import { cleanShortTitle, isCjk, parseShortTitle, shortTitlePrompt, SHORT_TITLE_CHARS_MAX } from './short-title'
import { withAiMetadata } from './tracing/ai'

/** Thread names use the independently managed title model. */
const SHORT_TITLE_MODEL = TITLE_MODEL

/**
 * Codex asks for structured output with `maxLength` on the title, then still trims and truncates what comes back.
 * An answer over the bound fails the schema; its text is then parsed and cut (below), so it is shortened, not lost.
 */
const SHORT_TITLE_SCHEMA = z.object({ title: z.string().max(SHORT_TITLE_CHARS_MAX) })

/**
 * One bounded short title from the small model, for a conversation (thread-title-server.ts): the same
 * model, admission, prompt, parsing and limits. Null when the model gives nothing usable. Throws what the model or
 * admission throws; callers decide that a title is never worth failing for.
 */
export async function generateShortTitle(ownerId: string, text: { title: string; body: string }, workspaceId: string, naming: readonly string[] = []): Promise<string | null> {
  const { hostedModel, admitHostedModel } = await import('@/lib/abuse/model')
  await admitHostedModel({ workspaceId, ownerId }, SHORT_TITLE_MODEL, { auditAllowed: false })
  const model = await hostedModel(workspaceId, SHORT_TITLE_MODEL, undefined, ownerId)
  const { instructions, prompt } = shortTitlePrompt(text, naming)
  const cjk = isCjk(`${text.title} ${text.body}`)
  try {
    const answer = await withAiMetadata({ operation: 'short_title' }, () => generateText({ model, instructions, prompt, output: Output.object({ schema: SHORT_TITLE_SCHEMA }), maxRetries: 1, abortSignal: AbortSignal.timeout(HOSTED_CALL_TIMEOUT_MS) }))
    return cleanShortTitle(answer.output.title, cjk)
  } catch (error) {
    // The model answered but not in the schema's shape: read the title out of its text, as before structured output.
    if (NoObjectGeneratedError.isInstance(error) && error.text) return parseShortTitle(error.text, cjk)
    // The model stopped without any output (a content filter, a length stop): no title, as before structured output.
    if (NoOutputGeneratedError.isInstance(error)) return null
    throw error
  }
}
