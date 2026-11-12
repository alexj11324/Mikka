import 'server-only'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { systemActor } from '@/lib/activity-actor'
import { db } from '@/lib/db'
import { bots, coordinatorEvents, issues } from '@/lib/db/schema'
import { FactoryError } from '@/lib/factory/contract'
import { issueForUser } from '@/lib/issue-access'
import { createIssueForUserInTransaction } from '@/lib/issue-create'
import { dispatchTaskIntent } from '@/lib/task-create-command'
import { attachInitialProject, insertExplicitTask, reconcileInitialProject } from '../task-create-scope'
import { withTaskCreationReceipt } from '@/lib/task-creation-receipt'
import { taskTitleInputSchema } from '@/lib/task-title-input'
import { compactTaskTitle } from '@/lib/short-title'
import { withTaskWorkspace } from '@/lib/task-workspace'

const inputSchema = z.object({ sourceEventId: z.uuid(), title: z.string().trim().min(1).max(200), confirmAccess: z.boolean().optional() }).strict()

/** The authenticated request is also the idempotency record for issue creation. */
export async function createIssueFromRequest(userId: string, input: { sourceEventId: string; title: string; confirmAccess?: boolean }) {
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
    const command = dispatchTaskIntent.optional().parse(event.payload.taskCommand)
    const confirmAccess = parsed.data.confirmAccess === true
    const actor = systemActor('coordinator')
    if ((command?.teamId || command?.projectId) && !event.payload.humanSessionId) throw new FactoryError('factoryHumanRequired')
    if (event.issueId) {
      const issue = await issueForUser(userId, event.issueId, false, tx)
      if (!issue || issue.workspaceId !== source.workspaceId) throw new FactoryError('factoryNotFound')
      if (command?.projectId) await reconcileInitialProject(tx, userId, source.workspaceId!, issue.id, command.projectId, actor, confirmAccess)
      return { issueId: issue.id, title: issue.title }
    }
    // A title the person typed in the task form wins over the model's: it is stored on the user's own event.
    const typed = taskTitleInputSchema.safeParse(event.payload.taskTitle)
    const title = typed.success ? typed.data : parsed.data.title
    const fields = { title, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: command?.description ?? event.payload.text as string }] }] }, status: 'todo' as const, priority: 'normal' as const }
    const requestId = command ? z.uuid().parse(event.payload.taskCreationRequestId) : undefined
    const create = async () => {
      let created
      if (command && requestId) {
        created = await insertExplicitTask(tx, userId, source.workspaceId!, requestId, fields, actor, command.teamId)
        if (command.projectId) await attachInitialProject(tx, userId, source.workspaceId!, created.taskId, command.projectId, actor, confirmAccess)
      } else {
        const issue = await createIssueForUserInTransaction(tx, userId, fields, systemActor('coordinator'), { workspaceId: source.workspaceId! })
        if (!issue?.identifier) throw new FactoryError('factoryInvalid')
        created = { taskId: issue.id, identifier: issue.identifier }
      }
      if (typed.success || command) await tx.update(issues).set({ shortTitle: compactTaskTitle({ title }), shortTitleFrom: title }).where(eq(issues.id, created.taskId))
      return created
    }
    const receipt = command ? await withTaskCreationReceipt(tx, userId, source.workspaceId!,
      requestId!, { ...command, sourceEventId: event.id, botId: event.botId }, create) : await create()
    await tx.update(coordinatorEvents).set({ issueId: receipt.taskId }).where(eq(coordinatorEvents.id, event.id))
    return { issueId: receipt.taskId, title }
  }))
}
