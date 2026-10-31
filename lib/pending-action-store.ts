import 'server-only'
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm'
import { isApprovalAction, parseActionInput } from '@/lib/composio-actions'
import { toolApprovalDefault } from '@/lib/composio-tool-hints'
import { resolveActionAccount, runComposioAction } from '@/lib/composio'
import { db } from '@/lib/db'
import { coordinatorEvents, pendingActions, repositorySettings } from '@/lib/db/schema'
import { taskDestinationSchema } from './task-destination'
import { repositoryPushApproved } from '@/lib/run-publication-policy'
import { actionOutcome, calendarEventSummary, PENDING_ACTION_TTL_MS, type PendingActionView } from '@/lib/pending-action-view'
import { prepareRepositoryApproval, validateRepositoryApproval } from '@/lib/repository-approval-proposal'

/** Most proposals one person can have waiting at once. */
const MAX_PENDING = 20

/** Prepare only: the repository permission is never changed by the model. */
export async function proposeRepositoryPush(userId: string, input: unknown, task?: { eventId: string; botId: string | null }) {
  const parsed = prepareRepositoryApproval(input)
  if (!parsed) return { error: 'repositoryInvalid' }
  return db.transaction(async tx => {
    if (task) {
      const [event] = await tx.select().from(coordinatorEvents).where(and(eq(coordinatorEvents.id, task.eventId), eq(coordinatorEvents.userId, userId), task.botId ? eq(coordinatorEvents.botId, task.botId) : isNull(coordinatorEvents.botId))).for('update')
      const destination = taskDestinationSchema.safeParse(event?.payload.taskDestination)
      if (!event || event.kind !== 'user_message' || !event.deliveredAt || !destination.success || destination.data.kind !== 'device') return { error: 'runInvalid' }
    }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['repository-approval', userId, parsed.remoteKey])}, 0))`)
    const [settings] = await tx.select({ push: repositorySettings.push }).from(repositorySettings)
      .where(and(eq(repositorySettings.userId, userId), eq(repositorySettings.remoteKey, parsed.remoteKey))).limit(1)
    if (settings?.push?.approved === false) return { status: 'denied' as const }
    if (repositoryPushApproved(settings?.push, userId)) return { status: 'approved' as const }
    const [existing] = await tx.select({ id: pendingActions.id, context: pendingActions.context }).from(pendingActions).where(and(
      eq(pendingActions.userId, userId), eq(pendingActions.action, 'approve_repository_push'), eq(pendingActions.status, 'pending'),
      gt(pendingActions.createdAt, new Date(Date.now() - PENDING_ACTION_TTL_MS)),
      sql`${pendingActions.input}->>'remoteKey' = ${parsed.remoteKey}`,
    )).limit(1)
    if (existing) {
      if (task) {
        const ids = Array.isArray(existing.context?.taskEventIds) ? existing.context.taskEventIds.filter((id): id is string => typeof id === 'string') : []
        await tx.update(pendingActions).set({ context: { ...existing.context, taskEventIds: [...new Set([...ids, task.eventId])] } }).where(eq(pendingActions.id, existing.id))
      }
      return { status: 'awaiting_approval' as const, actionId: existing.id }
    }
    const waiting = await tx.$count(pendingActions, and(eq(pendingActions.userId, userId), eq(pendingActions.status, 'pending'), gt(pendingActions.createdAt, new Date(Date.now() - PENDING_ACTION_TTL_MS))))
    if (waiting >= MAX_PENDING) return { error: 'tooManyPendingActions' }
    const id = crypto.randomUUID()
    await tx.insert(pendingActions).values({ id, userId, action: 'approve_repository_push', input: parsed, context: task ? { taskEventIds: [task.eventId] } : null })
    return { status: 'awaiting_approval' as const, actionId: id }
  })
}

/**
 * Sends mail or writes the calendar in the person's connected account, with
 * no card (decision 2026-10-31): the connection's grant is the permission.
 * Only a tool Composio marks destructive goes to `proposeAction` instead. The
 * row is written before dispatch and kept as the record; like other writes the
 * policy allows, it has no `decidedAt` and never shows as a card.
 */
export async function writeAccountAction(userId: string, action: string, input: unknown, selectedAccountId?: string) {
  if (!isApprovalAction(action)) return { error: 'integrationActionNotAllowed' }
  const parsed = parseActionInput(action, input)
  if (!parsed) return { error: 'invalidIntegrationInput' }
  const id = crypto.randomUUID()
  let recorded = false as boolean
  const result = await runComposioAction(userId, action, parsed, selectedAccountId, async (accountId, tool) => {
    if (toolApprovalDefault(tool.tags) === 'ask') return { error: 'integrationApprovalRequired' }
    await db.insert(pendingActions).values({ id, userId, action, input: parsed, connectedAccountId: accountId, status: 'running' })
    recorded = true
    return null
  })
  if ('error' in result && result.error === 'integrationApprovalRequired') return proposeAction(userId, action, parsed, selectedAccountId)
  // The gate runs before every dispatch, so an unrecorded result never sent anything.
  if (!recorded) return 'error' in result ? result : { error: 'integrationActionFailed' }
  if ('error' in result) {
    // operationUncertain stays running: it may have been sent, so never invite a resend.
    await db.update(pendingActions).set({ status: result.error === 'operationUncertain' ? 'running' : 'failed', error: result.error }).where(eq(pendingActions.id, id))
    return result
  }
  const outcome = actionOutcome(result.data)
  await db.update(pendingActions).set({ status: 'done', result: outcome }).where(eq(pendingActions.id, id))
  return { status: 'done' as const, actionId: id, outcome }
}

/**
 * Saves what an agent wants to do in the person's accounts, for the person to
 * approve. Nothing runs here. A calendar change also reads the event as it is
 * now, so the card can show what changes.
 */
export async function proposeAction(userId: string, action: string, input: unknown, selectedAccountId?: string) {
  if (!isApprovalAction(action)) return { error: 'integrationActionNotAllowed' }
  const parsed = parseActionInput(action, input)
  if (!parsed) return { error: 'invalidIntegrationInput' }
  const waiting = await db.$count(pendingActions, and(eq(pendingActions.userId, userId), eq(pendingActions.status, 'pending'), gt(pendingActions.createdAt, new Date(Date.now() - PENDING_ACTION_TTL_MS))))
  if (waiting >= MAX_PENDING) return { error: 'tooManyPendingActions: ask the person to approve or decline the waiting ones first' }
  const { accountId, accounts } = await resolveActionAccount(userId, action, selectedAccountId)
  if (!accountId) return accounts.length ? { error: 'integrationAccountSelectionRequired', accounts } : { error: 'integrationNotConnected' }
  let context: PendingActionView['context'] = null
  if (action === 'update_calendar_event') {
    const current = await runComposioAction(userId, 'get_calendar_event', { event_id: parsed.event_id }, accountId)
    if ('error' in current) return { error: `eventNotReadable: ${current.error}` }
    context = calendarEventSummary(current.data)
  }
  const id = crypto.randomUUID()
  await db.insert(pendingActions).values({ id, userId, action, input: parsed, context, connectedAccountId: accountId })
  return { status: 'awaiting_approval', actionId: id }
}

/** The person's proposals still waiting for them, newest first. */
export async function listPendingActions(userId: string): Promise<PendingActionView[]> {
  // Rendering existing cards must remain compatible before the account-binding
  // migration runs. Only proposal creation/execution needs the new column.
  const rows = await db.select({
    id: pendingActions.id, action: pendingActions.action, input: pendingActions.input,
    context: pendingActions.context, status: pendingActions.status, createdAt: pendingActions.createdAt,
  }).from(pendingActions)
    .where(and(eq(pendingActions.userId, userId), eq(pendingActions.status, 'pending'), gt(pendingActions.createdAt, new Date(Date.now() - PENDING_ACTION_TTL_MS))))
    .orderBy(desc(pendingActions.createdAt)).limit(MAX_PENDING)
  return rows.flatMap<PendingActionView>(row => {
    if (row.action === 'credential_operation' || row.action === 'browser_operation') {
      if (Date.now() - row.createdAt.getTime() > 5 * 60_000) return []
      return [{ id: row.id, action: row.action, input: { summary: row.input.summary, origin: row.input.origin, operation: row.input.operation, description: row.action === 'credential_operation' ? 'The page stays hidden until entered login fields are absent. This does not confirm authentication.' : undefined }, context: null, status: row.status, createdAt: row.createdAt.toISOString() }]
    }
    if (!isApprovalAction(row.action) && !(row.action === 'approve_repository_push' && validateRepositoryApproval(row.input))) return []
    return [{ id: row.id, action: row.action as PendingActionView['action'], input: row.input, context: row.context as PendingActionView['context'], status: row.status, createdAt: row.createdAt.toISOString() }]
  })
}
