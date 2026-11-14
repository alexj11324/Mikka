import 'server-only'
import { generateText } from 'ai'
import { COORDINATOR_MODEL } from '@/lib/coordinator/model'
import { isCjk, parseShortTitle, shortTitlePrompt } from './short-title'
import { withAiMetadata } from './tracing/ai'

/** The small text model that names conversations, as Capy names its threads; the Coordinator's flash model. */
const SHORT_TITLE_MODEL = COORDINATOR_MODEL
const SHORT_TITLE_TIMEOUT_MS = 10_000

/**
 * One bounded short title from the small model, for a conversation (conversation-title-server.ts): the same
 * model, admission, prompt, parsing and limits. Null when the model gives nothing usable. Throws what the model or
 * admission throws; callers decide that a title is never worth failing for.
 */
export async function generateShortTitle(ownerId: string, text: { title: string; body: string }, workspaceId: string, naming: readonly string[] = []): Promise<string | null> {
  const { hostedModel, admitHostedModel } = await import('@/lib/abuse/model')
  await admitHostedModel({ workspaceId, ownerId }, SHORT_TITLE_MODEL, { auditAllowed: false })
  const model = await hostedModel(workspaceId, SHORT_TITLE_MODEL, undefined, ownerId)
  const { instructions, prompt } = shortTitlePrompt(text, naming)
  const answer = await withAiMetadata({ operation: 'short_title' }, () => generateText({ model, instructions, prompt, maxRetries: 1, abortSignal: AbortSignal.timeout(SHORT_TITLE_TIMEOUT_MS) }))
  return parseShortTitle(answer.text, isCjk(`${text.title} ${text.body}`))
}
