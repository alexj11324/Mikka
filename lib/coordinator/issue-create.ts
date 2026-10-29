import 'server-only'
import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { systemActor } from '@/lib/activity-actor'
import { db } from '@/lib/db'
import { coordinatorEvents } from '@/lib/db/schema'
import { FactoryError } from '@/lib/factory/contract'
import { issueForUser } from '@/lib/issue-access'
import { createIssueForUserInTransaction } from '@/lib/issue-create'

const inputSchema = z.object({ sourceEventId: z.uuid(), title: z.string().trim().min(1).max(200) }).strict()

/** The authenticated request is also the idempotency record for issue creation. */
export async function createIssueFromRequest(userId: string, input: { sourceEventId: string; title: string }) {
  const parsed = inputSchema.safeParse(input)
  if (!parsed.success) throw new FactoryError('factoryInvalid')
  return db.transaction(async tx => {
    const [event] = await tx.select().from(coordinatorEvents).where(and(
      eq(coordinatorEvents.id, parsed.data.sourceEventId),
      eq(coordinatorEvents.userId, userId),
      eq(coordinatorEvents.kind, 'user_message'),
      isNull(coordinatorEvents.botId),
    )).for('update')
    if (!event || typeof event.payload.text !== 'string' || !event.payload.text.trim()) throw new FactoryError('factoryHumanRequired')
    if (event.issueId) {
      const issue = await issueForUser(userId, event.issueId, false, tx)
      if (!issue) throw new FactoryError('factoryNotFound')
      return { issueId: issue.id, title: issue.title }
    }
    const issue = await createIssueForUserInTransaction(tx, userId, {
      title: parsed.data.title,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: event.payload.text }] }] },
      status: 'todo',
      priority: 'normal',
    }, systemActor('coordinator'))
    if (!issue) throw new FactoryError('factoryInvalid')
    await tx.update(coordinatorEvents).set({ issueId: issue.id }).where(eq(coordinatorEvents.id, event.id))
    return { issueId: issue.id, title: issue.title }
  })
}
