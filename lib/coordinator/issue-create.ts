import 'server-only'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { systemActor } from '@/lib/activity-actor'
import { db } from '@/lib/db'
import { bots, coordinatorEvents, issues } from '@/lib/db/schema'
import { FactoryError } from '@/lib/factory/contract'
import { issueForUser } from '@/lib/issue-access'
import { createIssueForUserInTransaction } from '@/lib/issue-create'
import { taskTitleInputSchema } from '@/lib/task-title-input'
import { compactTaskTitle } from '@/lib/short-title'
import { withTaskWorkspace } from '@/lib/task-workspace'

const inputSchema = z.object({ sourceEventId: z.uuid(), title: z.string().trim().min(1).max(200) }).strict()

/** The authenticated request is also the idempotency record for issue creation. */
export async function createIssueFromRequest(userId: string, input: { sourceEventId: string; title: string }) {
  const parsed = inputSchema.safeParse(input)
  if (!parsed.success) throw new FactoryError('factoryInvalid')
  // A host-stored Bot is the event's tenant authority. Legacy events without
  // that binding cannot choose a workspace from text or from their creator.
  const [source] = await db.select({ workspaceId: bots.workspaceId }).from(coordinatorEvents)
    .innerJoin(bots, and(eq(bots.id, coordinatorEvents.botId), eq(bots.ownerId, userId)))
    .where(and(eq(coordinatorEvents.id, parsed.data.sourceEventId), eq(coordinatorEvents.userId, userId), eq(coordinatorEvents.kind, 'user_message')))
  if (!source?.workspaceId) throw new FactoryError('factoryHumanRequired')
  return withTaskWorkspace(userId, source.workspaceId, () => db.transaction(async tx => {
    const [row] = await tx.select({ event: coordinatorEvents }).from(coordinatorEvents)
      .innerJoin(bots, and(eq(bots.id, coordinatorEvents.botId), eq(bots.ownerId, userId), eq(bots.workspaceId, source.workspaceId)))
      .where(and(
      eq(coordinatorEvents.id, parsed.data.sourceEventId),
      eq(coordinatorEvents.userId, userId),
      eq(coordinatorEvents.kind, 'user_message'),
    )).for('update')
    const event = row?.event
    if (!event || typeof event.payload.text !== 'string' || !event.payload.text.trim()) throw new FactoryError('factoryHumanRequired')
    if (event.issueId) {
      const issue = await issueForUser(userId, event.issueId, false, tx)
      if (!issue || issue.workspaceId !== source.workspaceId) throw new FactoryError('factoryNotFound')
      return { issueId: issue.id, title: issue.title }
    }
    // A title the person typed in the task form wins over the model's: it is stored on the user's own event.
    const typed = taskTitleInputSchema.safeParse(event.payload.taskTitle)
    const issue = await createIssueForUserInTransaction(tx, userId, {
      title: typed.success ? typed.data : parsed.data.title,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: event.payload.text }] }] },
      status: 'todo',
      priority: 'normal',
    }, systemActor('coordinator'), { workspaceId: source.workspaceId })
    if (!issue) throw new FactoryError('factoryInvalid')
    // Preserve the person's full title; its derived navigation label obeys the shared compact-title limit.
    if (typed.success) await tx.update(issues).set({ shortTitle: compactTaskTitle({ title: typed.data }), shortTitleFrom: typed.data }).where(eq(issues.id, issue.id))
    await tx.update(coordinatorEvents).set({ issueId: issue.id }).where(eq(coordinatorEvents.id, event.id))
    return { issueId: issue.id, title: issue.title }
  }))
}
