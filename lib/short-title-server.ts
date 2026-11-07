import 'server-only'
import { generateText } from 'ai'
import { and, eq, isNull } from 'drizzle-orm'
import { gatewayAuth } from '@/lib/ai-gateway-auth'
import { zeroCatConfig } from '@/lib/abuse/zerocat'
import { selfHostedDefaultModelConfig } from '@/lib/default-model-config'
import { COORDINATOR_MODEL } from '@/lib/coordinator/model'
import { db } from '@/lib/db'
import { issues } from '@/lib/db/schema'
import { issueListChanged } from '@/lib/live/lists'
import { tiptapToText } from '@/lib/tiptap-text'
import { isCjk, parseShortTitle, shortTitlePrompt } from './short-title'
import { causeFields } from '@mikka/protocol/coded-error'
import { withAiMetadata } from './tracing/ai'

/** The small text model that names tasks; the Coordinator's flash model, as for 建议's action lines. */
const SHORT_TITLE_MODEL = COORDINATOR_MODEL
const SHORT_TITLE_TIMEOUT_MS = 10_000

/**
 * Writes one task's short title, once. Like 建议's action lines it runs on the default model (ZeroCat, with its Gateway
 * fallback; lib/abuse/model.ts) and goes through model admission, so the hosted usage budget caps the spend. The write only lands while the task has no
 * short title and still has the title it was written from, and it pushes the title change on the task's live keys.
 * Never throws.
 */
export async function writeShortTitle(issueId: string, ownerId: string): Promise<void> {
  try {
    if (!selfHostedDefaultModelConfig() && !zeroCatConfig() && !await gatewayAuth()) return
    const [task] = await db.select({ title: issues.title, content: issues.content, shortTitle: issues.shortTitle }).from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.userId, ownerId))).limit(1)
    if (!task || task.shortTitle) return
    const { hostedModel, admitHostedModel } = await import('@/lib/abuse/model')
    const { executionWorkspace } = await import('@/lib/execution-settings')
    const workspaceId = await executionWorkspace(ownerId, null)
    await admitHostedModel({ workspaceId, ownerId }, SHORT_TITLE_MODEL, { auditAllowed: false })
    const model = await hostedModel(workspaceId, SHORT_TITLE_MODEL, undefined, ownerId)
    const body = tiptapToText(task.content)
    const { instructions, prompt } = shortTitlePrompt({ title: task.title, body })
    const { text } = await withAiMetadata({ operation: 'short_title' }, () => generateText({ model, instructions, prompt, maxRetries: 1, abortSignal: AbortSignal.timeout(SHORT_TITLE_TIMEOUT_MS) }))
    const shortTitle = parseShortTitle(text, isCjk(`${task.title} ${body}`))
    if (!shortTitle) return
    await db.transaction(async tx => {
      const written = await tx.update(issues).set({ shortTitle, shortTitleFrom: task.title })
        .where(and(eq(issues.id, issueId), isNull(issues.shortTitle), eq(issues.title, task.title))).returning({ id: issues.id })
      // The same keys as a rename: the task list, the threads that run on it and the bot chat lists that name it.
      if (written.length) await issueListChanged(tx, issueId, true)
    })
  } catch (error) {
    // By name and code only: a failed query's message carries its parameters, which hold the task's title.
    console.error('Short title failed', JSON.stringify(causeFields(error)))
  }
}
