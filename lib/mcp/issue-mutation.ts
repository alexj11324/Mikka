import 'server-only'
import { createHash } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { db, withDatabaseTransaction } from '@/lib/db'
import { coordinatorEvents, devices, issueToolCalls, taskRequestBindings } from '@/lib/db/schema'
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
  userId: string, operation: 'create_issue' | 'update_issue', toolCallId: string, input: unknown, mutate: () => Promise<T>, request?: { eventId: string; botId: string | null },
): Promise<T> {
  if (!toolCallId || toolCallId.length > 200) throw new IssueToolCallConflict()
  const inputHash = createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex')
  const key = and(eq(issueToolCalls.userId, userId), eq(issueToolCalls.toolCallId, toolCallId))
  const committed = await db.transaction(async tx => withDatabaseTransaction(tx, async () => {
    let deviceId: string | null = null
    if (request) {
      if (operation !== 'create_issue') throw new IssueToolCallConflict()
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'task-request:' + request.eventId}, 0))`)
      const [event] = await tx.select().from(coordinatorEvents).where(and(eq(coordinatorEvents.id, request.eventId), eq(coordinatorEvents.userId, userId), eq(coordinatorEvents.kind, 'user_message'))).limit(1)
      const destination = taskDestinationSchema.safeParse(event?.payload.taskDestination)
      if (!event || event.botId !== request.botId || !event.deliveredAt || !destination.success || destination.data.kind !== 'device') throw new IssueToolCallConflict()
      deviceId = destination.data.deviceId
      const [binding] = await tx.select().from(taskRequestBindings).where(eq(taskRequestBindings.eventId, event.id)).limit(1)
      if (binding) {
        if (binding.userId !== userId || binding.botId !== request.botId || binding.deviceId !== deviceId || binding.inputHash !== inputHash) throw new IssueToolCallConflict()
        const [prior] = await tx.select().from(issueToolCalls).where(and(eq(issueToolCalls.userId, userId), eq(issueToolCalls.toolCallId, binding.toolCallId))).limit(1)
        if (!prior || prior.issueId !== binding.issueId || prior.operation !== operation || prior.inputHash !== inputHash) throw new IssueToolCallConflict()
        await requireIssueAccess(prior.issueId)
        return { result: prior.result as T, effects: prior.effects, receiptToolCallId: binding.toolCallId }
      }
      const [device] = await tx.select({ id: devices.id }).from(devices).where(and(eq(devices.id, deviceId), eq(devices.ownerId, userId), eq(devices.kind, 'local'), eq(devices.enabled, true))).limit(1)
      if (!device) throw new IssueToolCallConflict()
    }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'issue-tool:' + JSON.stringify([userId, toolCallId])}, 0))`)
    const [prior] = await tx.select().from(issueToolCalls).where(key).limit(1)
    if (prior) {
      if (request) throw new IssueToolCallConflict()
      if (prior.operation !== operation || prior.inputHash !== inputHash) throw new IssueToolCallConflict()
      await requireIssueAccess(prior.issueId)
      return { result: prior.result as T, effects: prior.effects, receiptToolCallId: toolCallId }
    }
    const effects: IssueEffect[] = []
    const result = await collectIssueEffects(effects, mutate)
    await tx.insert(issueToolCalls).values({ userId, operation, toolCallId, inputHash, issueId: result.id, result, effects })
    if (request && deviceId) await tx.insert(taskRequestBindings).values({ eventId: request.eventId, userId, botId: request.botId, deviceId, issueId: result.id, toolCallId, inputHash })
    return { result, effects, receiptToolCallId: toolCallId }
  }))
  // These effects are already safe to retry (outbox delivery, scope judgment and
  // a lease-guarded wake). A crash before clearing the receipt reruns only them.
  for (const effect of committed.effects) await runIssueEffect(effect)
  if (committed.effects.length) await db.update(issueToolCalls).set({ effects: [] }).where(and(eq(issueToolCalls.userId, userId), eq(issueToolCalls.toolCallId, committed.receiptToolCallId)))
  return committed.result
}
