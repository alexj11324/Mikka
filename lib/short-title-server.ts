import 'server-only'
import { generateText } from 'ai'
import { and, eq, isNull } from 'drizzle-orm'
import { gatewayAuth } from '@/lib/ai-gateway-auth'
import { afterJob } from '@/lib/background'
import { COORDINATOR_MODEL } from '@/lib/coordinator/model'
import { afterDatabaseCommit } from '@/lib/db/commit-effects'
import { db } from '@/lib/db'
import { issues } from '@/lib/db/schema'
import { issueListChanged } from '@/lib/live/lists'
import { tiptapToText } from '@/lib/tiptap-text'
import { isCjk, parseShortTitle, shortTitlePrompt } from './short-title'

/** The small text model that names tasks; the Coordinator's flash model, as for 建议's action lines. */
const SHORT_TITLE_MODEL = COORDINATOR_MODEL
const SHORT_TITLE_TIMEOUT_MS = 10_000

/**
 * Starts a task's short title once the transaction that created it commits (Alex 2026-11-06). Creation never waits for
 * it and never fails because of it: the call runs after the response, and anything that goes wrong leaves the task
 * with its own title.
 */
export function scheduleShortTitle(executor: object, issueId: string, ownerId: string) {
  try {
    afterDatabaseCommit(executor, `short-title:${issueId}`, () => afterJob('after:short-title', () => writeShortTitle(issueId, ownerId), { orRun: true, retainContext: true }))
  } catch (error) {
    console.warn('Short title not scheduled', error instanceof Error ? error.name : 'unknown')
  }
}

/**
 * Writes one task's short title, once. Like 建议's action lines it signs in with the app's gateway credential and goes
 * through model admission, so the hosted usage budget caps the spend. The write only lands while the task has no
 * short title and still has the title it was written from, and it pushes the title change on the task's live keys.
 * Never throws.
 */
export async function writeShortTitle(issueId: string, ownerId: string): Promise<void> {
  try {
    if (!await gatewayAuth()) return
    const [task] = await db.select({ title: issues.title, content: issues.content, shortTitle: issues.shortTitle }).from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.userId, ownerId))).limit(1)
    if (!task || task.shortTitle) return
    const { hostedModel, createTrustedGatewayModel } = await import('@/lib/abuse/model')
    const { modelAdmission } = await import('@/lib/model-admission/runtime')
    const { executionWorkspace } = await import('@/lib/execution-settings')
    const workspaceId = await executionWorkspace(ownerId, null)
    await modelAdmission.gateway({ workspaceId, ownerId }, SHORT_TITLE_MODEL, undefined, { auditAllowed: false })
    const model = await hostedModel(workspaceId, SHORT_TITLE_MODEL, await createTrustedGatewayModel(SHORT_TITLE_MODEL), ownerId)
    const body = tiptapToText(task.content)
    const { instructions, prompt } = shortTitlePrompt({ title: task.title, body })
    const { text } = await generateText({ model, instructions, prompt, maxRetries: 1, abortSignal: AbortSignal.timeout(SHORT_TITLE_TIMEOUT_MS) })
    const shortTitle = parseShortTitle(text, isCjk(`${task.title} ${body}`))
    if (!shortTitle) return
    await db.transaction(async tx => {
      const written = await tx.update(issues).set({ shortTitle, shortTitleFrom: task.title })
        .where(and(eq(issues.id, issueId), isNull(issues.shortTitle), eq(issues.title, task.title))).returning({ id: issues.id })
      // The same keys as a rename: the task list, the threads that run on it and the bot chat lists that name it.
      if (written.length) await issueListChanged(tx, issueId, true)
    })
  } catch (error) {
    console.error('Short title failed', error instanceof Error ? error.name : 'unknown')
  }
}
