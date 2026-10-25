import { AsyncLocalStorage } from 'node:async_hooks'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from '@/lib/db/schema'
import type { WorkspaceTransaction } from '@/lib/workspace-access'
import { resourceWakeAdmission } from './wake-admission'
import 'server-only'
import { and, eq } from 'drizzle-orm'
import { pool } from '@/lib/db'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { issueForUser } from '@/lib/issue-access'
import {
  CoordinatorInbox,
  WakeError,
  type InboxOptions,
  type WakeAuthorization,
  type WakeScopeGuard,
} from './inbox-receipts'
import { controlledWakeConfiguration } from './wake-controlled'

const workspaceScope = new AsyncLocalStorage<WorkspaceTransaction>()
const authorize: WakeAuthorization = async (tx, event) => {
  if (!(await tx.query('SELECT id FROM "user" WHERE id=$1 FOR SHARE', [event.userId])).rowCount)
    throw new WakeError('wakeOwnerUnavailable', 403)
  if (event.payload.workspaceId && event.payload.workspaceId !== event.wake_workspace_id)
    throw new WakeError('wakeWorkspaceMismatch', 403)
  if (event.wake_workspace_id) {
    const active = await (workspaceScope.getStore() ?? workspaceDb)
      .select({ id: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, event.wake_workspace_id),
          eq(workspaceMembers.userId, event.userId),
          eq(workspaceMembers.status, 'active'),
        ),
      )
      .limit(1)
    if (!active.length) throw new WakeError('wakeWorkspaceAccessDenied', 403)
  }
  if (
    event.issueId &&
    !(await issueForUser(
      event.userId,
      event.issueId,
      false,
      drizzle(tx, { schema }),
      workspaceScope.getStore() ?? workspaceDb,
    ))
  )
    throw new WakeError('wakeIssueAccessDenied', 403)
  if (event.runId) {
    const run = (
      await tx.query(
        `SELECT r."userId",r.status,r."stopRequestedAt",d."ownerId",m."workspaceId" FROM agent_runs r JOIN devices d ON d.id=r."deviceId" LEFT JOIN session_mailboxes m ON m.id=r."mailboxId" WHERE r.id=$1 FOR SHARE OF r,d`,
        [event.runId],
      )
    ).rows[0]
    if (!run || run.userId !== event.userId || run.ownerId !== event.userId)
      throw new WakeError('wakeRunAccessDenied', 403)
    if (run.workspaceId && event.wake_workspace_id && run.workspaceId !== event.wake_workspace_id)
      throw new WakeError('wakeWorkspaceMismatch', 403)
    if (run.stopRequestedAt || ['cancelled', 'stopped'].includes(run.status)) return 'notify_only'
  }
  return 'normal'
}
const scopeGuard: WakeScopeGuard = async (event, _phase, work) => {
  if (!event.wake_workspace_id && !event.issueId) return work()
  return workspaceDb.transaction(async (tx) => {
    try {
      if (event.wake_workspace_id) await requireWorkspace(tx, event.wake_workspace_id, event.userId)
    } catch (e) {
      if (e instanceof WorkspaceError) throw new WakeError('wakeWorkspaceAccessDenied', 403)
      throw e
    }
    return workspaceScope.run(tx, work)
  })
}
export function coordinatorInboxOptions(): InboxOptions {
  const controlled = controlledWakeConfiguration()
  return {
    authorize,
    scopeGuard,
    ...(controlled ? { leaseMs: 1000, deliveryLeaseMs: 250, retryBaseMs: 100 } : {}),
    admit: controlled ? async () => ({ admitted: true as const }) : resourceWakeAdmission,
  }
}
export function coordinatorInbox() {
  return new CoordinatorInbox(pool, coordinatorInboxOptions())
}
