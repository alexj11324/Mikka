import 'server-only'
import { createHash } from 'node:crypto'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { db, withDatabaseTransaction } from '@/lib/db'
import { coordinatorEvents, devices, issueToolCalls } from '@/lib/db/schema'
import { taskDestinationSchema } from '@/lib/task-destination'
import { requireIssueAccess } from '@/lib/issue-access'
import { collectIssueEffects, runIssueEffect, type IssueEffect } from '@/lib/issue-effects'

export class IssueToolCallConflict extends Error {
  constructor() { super('issueToolCallConflict') }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  return value
}

/**
 * The actions still enforce access, validation and revision checks. Their nested
 * transactions are savepoints in this transaction, so neither a partial issue
 * nor a successful mutation without its receipt survives a failed step.
 */
export async function idempotentIssueMutation<T extends { id: string } & Record<string, unknown>>(
  userId: string, operation: 'create_issue' | 'update_issue', toolCallId: string, input: unknown, mutate: () => Promise<T>, taskEvent?: { eventId: string; botId: string | null },
): Promise<T> {
  if (!toolCallId || toolCallId.length > 200) throw new IssueToolCallConflict()
  const inputHash = createHash('sha256').update(JSON.stringify(canonical(taskEvent ? { input, taskEvent } : input))).digest('hex')
  const key = and(eq(issueToolCalls.userId, userId), eq(issueToolCalls.toolCallId, toolCallId))
  const committed = await db.transaction(async tx => withDatabaseTransaction(tx, async () => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'issue-tool:' + JSON.stringify([userId, toolCallId])}, 0))`)
    let event: typeof coordinatorEvents.$inferSelect | undefined
    if (taskEvent) {
      if (operation !== 'create_issue') throw new IssueToolCallConflict()
      ;[event] = await tx.select().from(coordinatorEvents).where(and(eq(coordinatorEvents.id, taskEvent.eventId), eq(coordinatorEvents.userId, userId), taskEvent.botId ? eq(coordinatorEvents.botId, taskEvent.botId) : isNull(coordinatorEvents.botId))).for('update')
      const destination = taskDestinationSchema.safeParse(event?.payload.taskDestination)
      if (!event || event.kind !== 'user_message' || !event.deliveredAt || !destination.success) throw new IssueToolCallConflict()
      if (destination.data.kind === 'device') {
        const [device] = await tx.select({ id: devices.id }).from(devices).where(and(eq(devices.id, destination.data.deviceId), eq(devices.ownerId, userId), eq(devices.kind, 'local'), eq(devices.enabled, true))).for('update')
        if (!device) throw new IssueToolCallConflict()
      }
    }
    const [prior] = await tx.select().from(issueToolCalls).where(key).limit(1)
    if (prior) {
      if (prior.operation !== operation || prior.inputHash !== inputHash) throw new IssueToolCallConflict()
      if (taskEvent && event?.issueId !== prior.issueId) throw new IssueToolCallConflict()
      await requireIssueAccess(prior.issueId)
      return { result: prior.result as T, effects: prior.effects }
    }
    if (event?.issueId) throw new IssueToolCallConflict()
    const effects: IssueEffect[] = []
    const result = await collectIssueEffects(effects, mutate)
    if (event) await tx.update(coordinatorEvents).set({ issueId: result.id }).where(eq(coordinatorEvents.id, event.id))
    await tx.insert(issueToolCalls).values({ userId, operation, toolCallId, inputHash, issueId: result.id, result, effects })
    return { result, effects }
  }))
  // These effects are already safe to retry (outbox delivery, scope judgment and
  // a lease-guarded wake). A crash before clearing the receipt reruns only them.
  for (const effect of committed.effects) await runIssueEffect(effect)
  if (committed.effects.length) await db.update(issueToolCalls).set({ effects: [] }).where(key)
  return committed.result
}
