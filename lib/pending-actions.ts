import 'server-only'
import { and, eq, gt, sql } from 'drizzle-orm'
import { ActionFailureError } from '@/lib/action-error'
import { appToolCallSchema, APP_TOOL_ACTION } from '@/lib/app-tools'
import { isApprovalAction } from '@/lib/composio-actions'
import { runComposioAction } from '@/lib/composio'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { actionDecidedEvent } from '@/lib/coordinator-events'
import { wakeCoordinator } from '@/lib/coordinator/wake'
import { db, pool } from '@/lib/db'
import { coordinatorEvents, pendingActions, repositorySettings } from '@/lib/db/schema'
import { z } from 'zod'
import { taskDestinationSchema } from './task-destination'
import { validateRepositoryApproval } from '@/lib/repository-approval-proposal'
import { actionOutcome, PENDING_ACTION_TTL_MS } from '@/lib/pending-action-view'

/**
 * The person approves or declines one proposal. Approving runs exactly the
 * input they saw; the status moves off `pending` first, so a double click or a
 * second tab cannot run it twice. The Coordinator hears the outcome.
 */
export async function decidePendingAction(userId: string, id: string, approve: boolean) {
  const [candidate] = await db.select({ action: pendingActions.action }).from(pendingActions)
    .where(and(eq(pendingActions.id, id), eq(pendingActions.userId, userId))).limit(1)
  if (candidate?.action === 'approve_repository_push') {
    await db.transaction(async tx => {
      const [saved] = await tx.select({ input: pendingActions.input }).from(pendingActions)
        .where(and(eq(pendingActions.id, id), eq(pendingActions.userId, userId), eq(pendingActions.action, 'approve_repository_push'))).limit(1)
      const input = validateRepositoryApproval(saved?.input)
      if (!input) throw new ActionFailureError('pendingActionUnavailable')
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['repository-approval', userId, input.remoteKey])}, 0))`)
      const [request] = await tx.update(pendingActions)
        .set({ status: approve ? 'done' : 'declined', decidedAt: new Date() })
        .where(and(eq(pendingActions.id, id), eq(pendingActions.userId, userId), eq(pendingActions.action, 'approve_repository_push'), eq(pendingActions.status, 'pending'), gt(pendingActions.createdAt, new Date(Date.now() - PENDING_ACTION_TTL_MS))))
        .returning()
      if (!request) throw new ActionFailureError('pendingActionUnavailable')
      const decidedInput = validateRepositoryApproval(request.input)
      if (!decidedInput || decidedInput.remoteKey !== input.remoteKey || decidedInput.repo !== input.repo) throw new ActionFailureError('pendingActionUnavailable')
      const taskIds = z.array(z.uuid()).safeParse(request.context?.taskEventIds ?? [])
      if (!taskIds.success) throw new ActionFailureError('pendingActionUnavailable')
      const tasks: { eventId: string; botId: string | null; issueId: string | null }[] = []
      for (const id of new Set(taskIds.data)) {
        const [event] = await tx.select().from(coordinatorEvents).where(and(eq(coordinatorEvents.id, id), eq(coordinatorEvents.userId, userId), eq(coordinatorEvents.kind, 'user_message'))).limit(1)
        const destination = taskDestinationSchema.safeParse(event?.payload.taskDestination)
        if (!event?.deliveredAt || !destination.success || destination.data.kind !== 'device') throw new ActionFailureError('pendingActionUnavailable')
        tasks.push({ eventId: event.id, botId: event.botId, issueId: event.issueId })
      }
      if (approve) {
        const push = { approved: true, remote: 'origin', approvedByUserId: userId, approvedAt: new Date().toISOString() }
        await tx.insert(repositorySettings).values({ userId, remoteKey: input.remoteKey, push }).onConflictDoUpdate({
          target: [repositorySettings.userId, repositorySettings.remoteKey], set: { push, updatedAt: new Date() },
        })
      }
      const status = approve ? 'done' as const : 'declined' as const
      const action = { id: request.id, userId, action: request.action, input: request.input }
      if (tasks.length) {
        for (const task of tasks) await recordCoordinatorEvent(tx, actionDecidedEvent(action, { status, error: null, outcome: {} }, task))
      } else await recordCoordinatorEvent(tx, actionDecidedEvent(action, { status, error: null, outcome: {} }))
    })
    const status = approve ? 'done' as const : 'declined' as const
    await wakeCoordinator(userId)
    return { status, error: null }
  }
  const [row] = await db.update(pendingActions)
    .set({ status: approve ? 'running' : 'declined', decidedAt: new Date() })
    .where(and(eq(pendingActions.id, id), eq(pendingActions.userId, userId), eq(pendingActions.status, 'pending'), gt(pendingActions.createdAt, new Date(Date.now() - PENDING_ACTION_TTL_MS))))
    .returning()
  if (!row || (!isApprovalAction(row.action) && row.action !== 'browser_operation' && row.action !== 'credential_operation' && row.action !== APP_TOOL_ACTION)) throw new ActionFailureError('pendingActionUnavailable')

  if ((row.action === 'browser_operation' || row.action === 'credential_operation') && Date.now() - row.createdAt.getTime() > 5 * 60_000) {
    await db.update(pendingActions).set({ status: 'failed', error: 'browserActionExpired' }).where(eq(pendingActions.id, row.id))
    if (row.action === 'browser_operation') await (await import('@/lib/cloud-computer/action-reviews')).scrubBrowserMutation(pool, row.id)
    throw new ActionFailureError('pendingActionUnavailable')
  }
  let status: 'done' | 'failed' | 'declined' | 'running' = 'declined'
  let error: string | null = null
  let outcome: Record<string, string> = {}
  if (approve || (row.action === 'browser_operation' || row.action === 'credential_operation')) {
    const result = (row.action === 'browser_operation' || row.action === 'credential_operation')
      ? row.action === 'credential_operation'
        ? await (await import('@/lib/cloud-computer/credential-reviews')).executeCredentialOperation(pool, userId, row.input, approve)
        : await (await import('@/lib/cloud-computer/action-reviews')).executeApprovedBrowserAction(pool, userId, row.input, approve)
      : !row.connectedAccountId
        ? { error: 'integrationAccountNotBound' }
        : row.action === APP_TOOL_ACTION
          ? await runApprovedAppToolCall(userId, row.input, row.connectedAccountId)
          : await runComposioAction(userId, row.action, row.input, row.connectedAccountId)
    if ('error' in result) {
      status = (isApprovalAction(row.action) || row.action === APP_TOOL_ACTION) && result.error === 'operationUncertain' ? 'running' : 'failed'
      error = result.error
    } else {
      status = approve ? 'done' : 'declined'
      outcome = actionOutcome(result.data)
    }
    await db.update(pendingActions).set({ status, error, result: outcome }).where(eq(pendingActions.id, row.id))
  }
  await recordCoordinatorEvent(db, actionDecidedEvent({ id: row.id, userId, action: row.action, input: row.action === 'credential_operation' || row.action === 'browser_operation' ? { summary: (row.input as Record<string, unknown>).summary } : row.input }, { status, error, outcome }))
  await wakeCoordinator(userId)
  return { status, error }
}

/**
 * Runs exactly the store-app call the person approved, pinned to the tool
 * version it was proposed with. Anything after dispatch that is not a clear
 * success is uncertain: it may have happened, so it is never resent.
 */
async function runApprovedAppToolCall(userId: string, input: unknown, accountId: string): Promise<{ data: Record<string, unknown> } | { error: string }> {
  const call = appToolCallSchema.safeParse(input)
  if (!call.success) return { error: 'invalidIntegrationInput' }
  const [{ getComposio }, { executeAppToolCall }] = await Promise.all([import('@/lib/composio'), import('@/lib/app-tools-server')])
  const client = getComposio()
  if (!client) return { error: 'composioNotConfigured' }
  try {
    const result = await executeAppToolCall(client, userId, call.data, accountId)
    return result.successful ? { data: result.data ?? {} } : { error: 'operationUncertain' }
  } catch {
    return { error: 'operationUncertain' }
  }
}
