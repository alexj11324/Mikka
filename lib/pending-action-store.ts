import 'server-only'
import { and, desc, eq, gt, sql } from 'drizzle-orm'
import { isApprovalAction, parseActionInput } from '@/lib/composio-actions'
import { runComposioAction } from '@/lib/composio'
import { db } from '@/lib/db'
import { pendingActions, repositorySettings } from '@/lib/db/schema'
import { repositoryPushApproved } from '@/lib/run-publication-policy'
import { calendarEventSummary, PENDING_ACTION_TTL_MS, type PendingActionView } from '@/lib/pending-action-view'
import { prepareRepositoryApproval, validateRepositoryApproval } from '@/lib/repository-approval-proposal'

/** Most proposals one person can have waiting at once. */
const MAX_PENDING = 20

/** Prepare only: the repository permission is never changed by the model. */
export async function proposeRepositoryPush(userId: string, input: unknown) {
  const parsed = prepareRepositoryApproval(input)
  if (!parsed) return { error: 'repositoryInvalid' }
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['repository-approval', userId, parsed.remoteKey])}, 0))`)
    const [settings] = await tx.select({ push: repositorySettings.push }).from(repositorySettings)
      .where(and(eq(repositorySettings.userId, userId), eq(repositorySettings.remoteKey, parsed.remoteKey))).limit(1)
    if (settings?.push?.approved === false) return { status: 'denied' as const }
    if (repositoryPushApproved(settings?.push, userId)) return { status: 'approved' as const }
    const [existing] = await tx.select({ id: pendingActions.id }).from(pendingActions).where(and(
      eq(pendingActions.userId, userId), eq(pendingActions.action, 'approve_repository_push'), eq(pendingActions.status, 'pending'),
      gt(pendingActions.createdAt, new Date(Date.now() - PENDING_ACTION_TTL_MS)),
      sql`${pendingActions.input}->>'remoteKey' = ${parsed.remoteKey}`,
    )).limit(1)
    if (existing) return { status: 'awaiting_approval' as const, actionId: existing.id }
    const waiting = await tx.$count(pendingActions, and(eq(pendingActions.userId, userId), eq(pendingActions.status, 'pending'), gt(pendingActions.createdAt, new Date(Date.now() - PENDING_ACTION_TTL_MS))))
    if (waiting >= MAX_PENDING) return { error: 'tooManyPendingActions' }
    const id = crypto.randomUUID()
    await tx.insert(pendingActions).values({ id, userId, action: 'approve_repository_push', input: parsed, context: null })
    return { status: 'awaiting_approval' as const, actionId: id }
  })
}

/**
 * Saves what an agent wants to do in the person's accounts, for the person to
 * approve. Nothing runs here. A calendar change also reads the event as it is
 * now, so the card can show what changes.
 */
export async function proposeAction(userId: string, action: string, input: unknown) {
  if (!isApprovalAction(action)) return { error: 'integrationActionNotAllowed' }
  const parsed = parseActionInput(action, input)
  if (!parsed) return { error: 'invalidIntegrationInput' }
  const waiting = await db.$count(pendingActions, and(eq(pendingActions.userId, userId), eq(pendingActions.status, 'pending'), gt(pendingActions.createdAt, new Date(Date.now() - PENDING_ACTION_TTL_MS))))
  if (waiting >= MAX_PENDING) return { error: 'tooManyPendingActions: ask the person to approve or decline the waiting ones first' }
  let context: PendingActionView['context'] = null
  if (action === 'update_calendar_event') {
    const current = await runComposioAction(userId, 'get_calendar_event', { event_id: parsed.event_id })
    if ('error' in current) return { error: `eventNotReadable: ${current.error}` }
    context = calendarEventSummary(current.data)
  }
  const id = crypto.randomUUID()
  await db.insert(pendingActions).values({ id, userId, action, input: parsed, context })
  return { status: 'awaiting_approval', actionId: id }
}

/** The person's proposals still waiting for them, newest first. */
export async function listPendingActions(userId: string): Promise<PendingActionView[]> {
  const rows = await db.select().from(pendingActions)
    .where(and(eq(pendingActions.userId, userId), eq(pendingActions.status, 'pending'), gt(pendingActions.createdAt, new Date(Date.now() - PENDING_ACTION_TTL_MS))))
    .orderBy(desc(pendingActions.createdAt)).limit(MAX_PENDING)
  return rows.flatMap(row => {
    if (!isApprovalAction(row.action) && !(row.action === 'approve_repository_push' && validateRepositoryApproval(row.input))) return []
    return [{ id: row.id, action: row.action as PendingActionView['action'], input: row.input, context: row.context as PendingActionView['context'], status: row.status, createdAt: row.createdAt.toISOString() }]
  })
}
