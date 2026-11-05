import 'server-only'
import { pendingActionsChanged } from './live/pending-actions'
import { and, eq, gt } from 'drizzle-orm'
import { ActionFailureError } from '@/lib/action-error'
import { appToolCallSchema, APP_TOOL_ACTION } from '@/lib/app-tools'
import { isApprovalAction } from '@/lib/composio-actions'
import { runComposioAction } from '@/lib/composio'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { actionDecidedEvent } from '@/lib/coordinator-events'
import { wakeCoordinator } from '@/lib/coordinator/wake'
import { db, pool } from '@/lib/db'
import { pendingActions } from '@/lib/db/schema'
import { actionOutcome, PENDING_ACTION_TTL_MS } from '@/lib/pending-action-view'

/**
 * The person approves or declines one proposal. Approving runs exactly the
 * input they saw; the status moves off `pending` first, so a double click or a
 * second tab cannot run it twice. The Coordinator hears the outcome.
 */
export async function decidePendingAction(userId: string, id: string, approve: boolean) {
  const [row] = await db.update(pendingActions)
    .set({ status: approve ? 'running' : 'declined', decidedAt: new Date() })
    .where(and(eq(pendingActions.id, id), eq(pendingActions.userId, userId), eq(pendingActions.status, 'pending'), gt(pendingActions.createdAt, new Date(Date.now() - PENDING_ACTION_TTL_MS))))
    .returning()
  if (!row || (!isApprovalAction(row.action) && row.action !== 'browser_operation' && row.action !== 'credential_operation' && row.action !== APP_TOOL_ACTION)) throw new ActionFailureError('pendingActionUnavailable')
  await pendingActionsChanged(db, row.id, userId)

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
      : row.action === APP_TOOL_ACTION
        ? await runApprovedAppToolCall(userId, row.input, row.connectedAccountId ?? null)
        : !row.connectedAccountId
          ? { error: 'integrationAccountNotBound' }
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
  await recordCoordinatorEvent(db, actionDecidedEvent({ id: row.id, userId, action: row.action, input: row.action === 'credential_operation' || row.action === 'browser_operation' ? { summary: (row.input as Record<string, unknown>).summary } : row.input }, { status, error, outcome }, { botId: row.botId }))
  await wakeCoordinator(userId)
  return { status, error }
}

/**
 * Runs exactly the store-app call the person approved, pinned to the tool
 * version it was proposed with. Anything after dispatch that is not a clear
 * success is uncertain: it may have happened, so it is never resent.
 */
async function runApprovedAppToolCall(userId: string, input: unknown, accountId: string | null): Promise<{ data: Record<string, unknown> } | { error: string }> {
  const call = appToolCallSchema.safeParse(input)
  if (!call.success) return { error: 'invalidIntegrationInput' }
  const [{ getComposio }, { executeAppToolCall }] = await Promise.all([import('@/lib/composio'), import('@/lib/app-tools-server')])
  const client = getComposio()
  if (!client) return { error: 'composioNotConfigured' }
  // A call proposed without an account runs only for an app that needs none;
  // anything else stays bound to the account the person approved it in.
  if (!accountId) {
    const { composioToolkitLister, isNoAuthToolkit } = await import('@/lib/plugins/catalog')
    if (!await isNoAuthToolkit(composioToolkitLister(client), call.data.toolkit).catch(() => false)) return { error: 'integrationAccountNotBound' }
  }
  try {
    const result = await executeAppToolCall(client, userId, call.data, accountId)
    return result.successful ? { data: result.data ?? {} } : { error: 'operationUncertain' }
  } catch {
    return { error: 'operationUncertain' }
  }
}

