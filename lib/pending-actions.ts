import 'server-only'
import { and, eq, gt, sql } from 'drizzle-orm'
import { ActionFailureError } from '@/lib/action-error'
import { isApprovalAction } from '@/lib/composio-actions'
import { runComposioAction } from '@/lib/composio'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { actionDecidedEvent } from '@/lib/coordinator-events'
import { wakeCoordinator } from '@/lib/coordinator/wake'
import { db } from '@/lib/db'
import { pendingActions, repositorySettings } from '@/lib/db/schema'
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
      if (approve) {
        const push = { approved: true, remote: 'origin', approvedByUserId: userId, approvedAt: new Date().toISOString() }
        await tx.insert(repositorySettings).values({ userId, remoteKey: input.remoteKey, push }).onConflictDoUpdate({
          target: [repositorySettings.userId, repositorySettings.remoteKey], set: { push, updatedAt: new Date() },
        })
      }
      const status = approve ? 'done' as const : 'declined' as const
      await recordCoordinatorEvent(tx, actionDecidedEvent({ id: request.id, userId, action: request.action, input: request.input }, { status, error: null, outcome: {} }))
    })
    const status = approve ? 'done' as const : 'declined' as const
    await wakeCoordinator(userId)
    return { status, error: null }
  }
  const [row] = await db.update(pendingActions)
    .set({ status: approve ? 'running' : 'declined', decidedAt: new Date() })
    .where(and(eq(pendingActions.id, id), eq(pendingActions.userId, userId), eq(pendingActions.status, 'pending'), gt(pendingActions.createdAt, new Date(Date.now() - PENDING_ACTION_TTL_MS))))
    .returning()
  if (!row || !isApprovalAction(row.action)) throw new ActionFailureError('pendingActionUnavailable')

  let status: 'done' | 'failed' | 'declined' = 'declined'
  let error: string | null = null
  let outcome: Record<string, string> = {}
  if (approve) {
    const result = await runComposioAction(userId, row.action, row.input)
    if ('error' in result) {
      status = 'failed'
      error = result.error
    } else {
      status = 'done'
      outcome = actionOutcome(result.data)
    }
    await db.update(pendingActions).set({ status, error, result: outcome }).where(eq(pendingActions.id, row.id))
  }
  await recordCoordinatorEvent(db, actionDecidedEvent({ id: row.id, userId, action: row.action, input: row.input }, { status, error, outcome }))
  await wakeCoordinator(userId)
  return { status, error }
}
